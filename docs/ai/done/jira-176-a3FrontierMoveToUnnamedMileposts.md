# JIRA-176: A3 Frontier Move to Unnamed Mileposts

## Problem

Bots build track but don't move during their turn, even when they have 9-12 mileposts of movement budget available. This wastes the bot's most constrained resource — turns.

## Root Cause

When the next route stop is off-network (needs building), `TurnExecutorPlanner` enters A3 frontier approach logic (lines 476-569) before Phase B (build). A3 is supposed to move the bot toward the construction frontier — the dead-end of existing track closest to the build target — so the bot uses its movement budget instead of wasting it.

However, A3 **only works when the frontier node is a named city**. Three independent filters reject unnamed milepost dead-ends:

1. **Filter 1** (`TurnExecutorPlanner.ts:493-494`):
   ```typescript
   const reachableFrontier = frontierNodes.filter(
     n => n.cityName && n.cityName !== currentCity,
   );
   ```
   Removes all unnamed milepost frontier nodes.

2. **Filter 2** (`TurnExecutorPlanner.ts:516-525`): Directional guard uses `n.cityName` to look up coordinates — unnamed nodes fail silently (return false).

3. **Filter 3** (`TurnExecutorPlanner.ts:537`):
   ```typescript
   if (!frontierNode.cityName) continue;
   ```
   Redundant skip of unnamed nodes.

Additionally, `ActionResolver.resolveMove()` (`ActionResolver.ts:415-437`) only accepts a city name string (`details.to`), not coordinates. Even if unnamed nodes survived the filters, the move resolver can't target them.

**Irony**: `getNetworkFrontier()` in `routeHelpers.ts:291-303` was explicitly fixed (JIRA-156 Bug B) to include unnamed milepost dead-ends, but the consumer immediately filters them out.

## Impact

- **Every turn** where the bot's track dead-ends at an unnamed milepost (common during long route builds), the bot wastes its entire 9-12 milepost movement budget
- The bot sits still and only builds, when it could be moving along existing track toward the frontier
- This is visible in game logs as turns with `action=BuildTrack` and zero movement, while `moveBudget.wasted` equals the full speed

## Proposed Fix (Option 1: Make resolveMove accept coordinates)

### Step 1: Extend `ActionResolver.resolveMove()` to accept coordinates

Add coordinate-based movement as an alternative to city-name movement:

```typescript
static async resolveMove(
  details: Record<string, string | number>,  // allow numeric coords
  snapshot: WorldSnapshot,
  remainingSpeed?: number,
): Promise<ResolvedAction> {
  // Existing city-name path
  const targetCity = details.to ?? details.toward ?? details.city;
  
  // NEW: coordinate-based path
  const targetRow = details.toRow as number | undefined;
  const targetCol = details.toCol as number | undefined;
  
  if (!targetCity && (targetRow === undefined || targetCol === undefined)) {
    return { success: false, error: 'MOVE requires details.to (city name) or details.toRow+toCol (coordinates).' };
  }
  
  // If coordinates provided, resolve target positions directly
  let targetPositions: GridCoord[];
  if (targetRow !== undefined && targetCol !== undefined) {
    targetPositions = [{ row: targetRow, col: targetCol }];
  } else {
    targetPositions = ActionResolver.findCityMilepost(targetCity!, snapshot);
    if (targetPositions.length === 0) {
      return { success: false, error: `Destination city "${targetCity}" not found.` };
    }
  }
  // ... rest of pathfinding uses targetPositions (already does)
}
```

**Key**: The pathfinding logic downstream of `resolveMove` already works with `targetPositions: GridCoord[]` — it doesn't care if the target is a city or a milepost. The change is only in the input parsing.

### Step 2: Update A3 in TurnExecutorPlanner to use coordinates

Replace the three filters with coordinate-aware logic:

```typescript
// Get frontier nodes sorted by distance to build target
const frontierNodes = getNetworkFrontier(snapshot, undefined, targetCity);

// Filter out bot's current position
const currentPos = context.position;
const reachableFrontier = frontierNodes.filter(n => {
  if (!currentPos) return true;
  return !(n.row === currentPos.row && n.col === currentPos.col);
});

// Directional guard: only move to nodes closer to target than bot
let directionalFrontier = reachableFrontier;
if (currentPos) {
  const grid = loadGridPoints();
  let targetRow = -1, targetCol = -1;
  for (const [, gp] of grid) {
    if (gp.name && gp.name === targetCity) {
      targetRow = gp.row; targetCol = gp.col; break;
    }
  }
  if (targetRow >= 0) {
    const botDist = Math.abs(currentPos.row - targetRow) + Math.abs(currentPos.col - targetCol);
    directionalFrontier = reachableFrontier.filter(n => {
      const nodeDist = Math.abs(n.row - targetRow) + Math.abs(n.col - targetCol);
      return nodeDist < botDist;
    });
  }
}

// Try each frontier node — use coordinates for unnamed, city name for named
let a3MoveSucceeded = false;
for (const frontierNode of directionalFrontier) {
  const moveDetails = frontierNode.cityName
    ? { to: frontierNode.cityName }
    : { toRow: frontierNode.row, toCol: frontierNode.col };

  const a3MoveResult = await ActionResolver.resolveMove(
    moveDetails, snapshot, remainingBudget,
  );

  if (a3MoveResult.success && a3MoveResult.plan) {
    // ... existing success handling (unchanged)
    break;
  }
}
```

### Step 3: Verify pathfinding works for milepost targets

The existing pathfinding in `resolveMove` uses BFS on the bot's track graph to find a path from current position to target. Since unnamed mileposts ARE on the bot's track (they're endpoints of existing segments), the BFS will find them — the pathfinding already works with coordinates, not city names.

**Verify**: `ActionResolver.findPath()` or equivalent BFS takes `targetPositions: GridCoord[]` and searches the track graph. No city-name dependency in the pathfinding layer.

## Files to Change

| File | Change |
|------|--------|
| `src/server/services/ai/ActionResolver.ts` | Extend `resolveMove()` to accept `toRow`/`toCol` coordinates as alternative to city name |
| `src/server/services/ai/TurnExecutorPlanner.ts` | Update A3 frontier logic (lines 488-567) to remove cityName filters and use coordinate-based moves for unnamed mileposts |

## Acceptance Criteria

- AC1: `resolveMove({ toRow: 25, toCol: 40 })` pathfinds to that milepost using existing track
- AC2: A3 frontier move targets unnamed milepost dead-ends (not just cities)
- AC3: Directional guard works with coordinates directly (no cityName lookup)
- AC4: Bot moves toward unnamed frontier milepost when it's the closest point to build target
- AC5: Bot still moves to named city frontier nodes as before (no regression)
- AC6: `compositionTrace.a3.movePreprended` is true when an unnamed milepost move succeeds

## Risks

- **Low**: `resolveMove` coordinate path bypasses the "already at city" check (`isBotAtCity`). Need to add a coordinate-based position check to prevent zero-length moves.
- **Low**: If the unnamed milepost is only 1-2 hops from the bot's current position, the move may consume minimal budget. This is still better than zero movement.
- **None**: Existing city-name path is unchanged — all current callers of `resolveMove({ to: "cityName" })` continue working as before.
