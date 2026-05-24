# JIRA-34: Ferry-Aware Track Cost Estimation

## Problem

`ContextBuilder.estimateTrackCost()` uses raw `hexDistance * 1.5` to estimate the cost of building track to a city. This calculation punches straight through water tiles, producing wildly inaccurate estimates for cross-water routes.

**Observed in game `85a69b96`:** Haiku bot at T14 commits to Cattle Bern→Kobenhavn based on `trackCostToDelivery=11M`. The actual route requires building overland to the Sassnitz ferry port, paying the ferry cost (8-16M), then building from the Danish port to Kobenhavn — real cost ~30-40M. The bot bankrupts itself chasing a route it can never afford.

The downstream `computeBuildSegments` Dijkstra correctly handles ferries (free crossing when departure port is built, ferry waypoint redirect, landmass detection). But by the time it runs, the bot has already committed to the route based on the bogus estimate.

## Root Cause

`ContextBuilder.estimateTrackCost()` (line 1674) computes:
```typescript
const dist = hexDistance(cityPoint.row, cityPoint.col, fp.row, fp.col);
return Math.round(minDist * AVG_COST_PER_MILEPOST); // 1.5M per hex
```

This ignores:
- Water tiles between source and target (hex distance goes through ocean)
- Ferry port costs (4-16M per ferry connection)
- The need to route around landmasses to reach a ferry port

## Three States to Handle

| Bot Track State | Correct Estimate |
|----------------|-----------------|
| **No track near any ferry** | Overland distance to departure port × AVG_COST + ferry cost + far-side port to target × AVG_COST |
| **Track at departure port (ferry paid)** | Far-side port to target × AVG_COST only (crossing is free) |
| **Track already on far side** | Normal distance from far-side track endpoint to target |

## Solution

### 1. Extract shared landmass/ferry utilities

`computeBuildSegments` already has the logic (lines 455-520) for:
- Landmass BFS from source positions (flood-fill non-water tiles)
- Detecting cross-water targets
- Checking if bot can already cross a ferry (`botCanCrossFerry`)
- Finding departure ferry ports on the source landmass

Extract these into a shared utility so `estimateTrackCost` can reuse them:

```typescript
// New file or addition to MapTopology.ts

interface LandmassInfo {
  /** Set of "row,col" keys reachable from sources without crossing water */
  tiles: Set<string>;
}

interface FerryRouteInfo {
  /** Whether the bot has track at a departure ferry port */
  canCrossFerry: boolean;
  /** Departure-side ferry ports on the source landmass */
  departurePorts: GridCoord[];
  /** Arrival-side ferry ports (partners of departure ports) */
  arrivalPorts: GridCoord[];
  /** Cheapest ferry connection cost */
  cheapestFerryCost: number;
}

function computeLandmass(sources: GridCoord[], grid: Map<string, GridPointData>): LandmassInfo;
function computeFerryRouteInfo(sourceLandmass: Set<string>, onNetwork: Set<string>): FerryRouteInfo;
```

### 2. Update `estimateTrackCost`

```typescript
private static estimateTrackCost(
  cityName: string,
  segments: TrackSegment[],
  gridPoints: GridPoint[],
  fromCity?: string,
): number {
  const cityPoints = gridPoints.filter(gp => gp.city?.name === cityName);
  if (cityPoints.length === 0) return 0;

  // ... existing logic for finding nearest track endpoint ...

  // NEW: Check if target is on a different landmass
  const sourceLandmass = computeLandmass(trackEndpoints, grid);
  const targetOnSourceLandmass = cityPoints.some(
    cp => sourceLandmass.tiles.has(`${cp.row},${cp.col}`)
  );

  if (targetOnSourceLandmass) {
    // Same landmass — current hex distance logic is acceptable
    return Math.round(minDist * AVG_COST_PER_MILEPOST);
  }

  // Cross-water target — check ferry state
  const onNetwork = new Set(trackEndpoints.map(e => `${e.row},${e.col}`));
  const ferryInfo = computeFerryRouteInfo(sourceLandmass.tiles, onNetwork);

  if (ferryInfo.canCrossFerry) {
    // Bot already has track at a departure ferry port — crossing is free
    // Estimate = distance from arrival port to target
    let minFarDist = Infinity;
    for (const arrival of ferryInfo.arrivalPorts) {
      for (const cp of cityPoints) {
        const dist = hexDistance(arrival.row, arrival.col, cp.row, cp.col);
        minFarDist = Math.min(minFarDist, dist);
      }
    }
    return Math.round(minFarDist * AVG_COST_PER_MILEPOST);
  }

  // Bot has no ferry access — estimate full route
  // 1. Overland to nearest departure port
  let minPortDist = Infinity;
  let bestArrivalDist = Infinity;
  for (const dep of ferryInfo.departurePorts) {
    // Distance from nearest track to departure port
    let nearestTrackDist = Infinity;
    for (const ep of trackEndpoints) {
      const d = hexDistance(ep.row, ep.col, dep.row, dep.col);
      nearestTrackDist = Math.min(nearestTrackDist, d);
    }
    // Find the paired arrival port and its distance to target
    // (ferryAdjacency lookup)
    // ... arrival port distance to target ...
    const totalViaThisFerry = nearestTrackDist + arrivalToTarget;
    if (totalViaThisFerry < minPortDist + bestArrivalDist) {
      minPortDist = nearestTrackDist;
      bestArrivalDist = arrivalToTarget;
    }
  }

  return Math.round(
    minPortDist * AVG_COST_PER_MILEPOST +
    ferryInfo.cheapestFerryCost +
    bestArrivalDist * AVG_COST_PER_MILEPOST
  );
}
```

### 3. Update `computeBuildSegments` to use shared utilities

Replace the inline landmass BFS (lines 455-474) and ferry detection (lines 480-520) with calls to the new shared utilities. No behavior change — just deduplication.

## Impact on Demand Scoring

With ferry-aware estimates, the Cattle Bern→Kobenhavn demand at T14 would score:
- **Before:** `trackCostToDelivery=11M`, `efficiencyPerTurn=3.0M/t`, `score=9.3` (rank #3)
- **After:** `trackCostToDelivery=~35M`, `efficiencyPerTurn=-0.7M/t`, `score=~2.0` (rank #8+)

The LLM would see the route as unaffordable and pick something else — preventing the bankruptcy spiral.

## Key Files

- `src/server/services/ai/ContextBuilder.ts` — `estimateTrackCost()` (line 1674)
- `src/server/services/ai/computeBuildSegments.ts` — Landmass BFS (lines 455-474), ferry waypoint (lines 480-520)
- `src/server/services/ai/MapTopology.ts` — Potential home for shared landmass/ferry utilities
- `src/shared/services/majorCityGroups.ts` — `getFerryEdges()` already available

## Testing

- Unit test: `estimateTrackCost` for same-landmass city returns similar to current
- Unit test: `estimateTrackCost` for cross-water city with no ferry access returns overland + ferry + far-side cost
- Unit test: `estimateTrackCost` for cross-water city with ferry already paid returns only far-side cost
- Integration: Demand scoring ranks cross-water demands lower when bot can't afford the ferry route
