# JIRA-111: Bot Gets Zero Movement After Ferry Crossing When Ferry Port Shares City Name

## Symptom

Game `aeeb3dc1`, Haiku bot, turn 7+. Bot crosses the ferry to Newcastle ferry port (10,33) but never moves onward. It has 5 mileposts of movement budget, uses 0, and wastes all 5. On subsequent turns it passes forever, stuck at the ferry port.

## Timeline

| Turn | Position | Action | Speed | Budget Used/Wasted |
|------|----------|--------|-------|--------------------|
| 5 | (15,46) → (12,46) | MoveTrain toward Newcastle | 9 | 3/6 (stopped at ferry port — correct) |
| 6 | (12,46) → (10,33) | MoveTrain (ferry crossing) | 5 | 0/5 — **zero post-crossing movement** |
| 7 | (10,33) → (10,33) | PassTurn ("Move failed") | 5 | 0/5 |
| 8 | (10,33) → (10,33) | PassTurn ("Move failed") | 5 | 0/5 |

## Root Cause

**Regression introduced by JIRA-110 Bug 1 fix** (commit `276405c`).

The fix removed the `FerryPort` terrain exclusion from `ActionResolver.findCityMilepost()` so that ferry port cities (like Dover) could be targeted as MOVE destinations. However, some ferry ports share names with nearby cities. The Newcastle ferry port at (10,33) has `name: "Newcastle"`, and the actual SmallCity is at (9,32) — also `name: "Newcastle"`.

### Data model

```
(10,33): { terrain: 7 (FerryPort), name: "Newcastle", ocean: "North Sea" }
(9,32):  { terrain: 4 (SmallCity), name: "Newcastle" }
```

### Failure chain

1. Bot is at ferry port (12,46). `resolveMove("Newcastle")` is called.
2. `findCityMilepost("Newcastle")` returns **both** `(9,32)` and `(10,33)` — the SmallCity AND the FerryPort.
3. `resolveFerryCrossing` fires, teleporting `fromPosition` from (12,46) → (10,33).
4. `atTargetAfterFerry` check (line 268) compares `fromPosition` (10,33) against `targetPositions` — finds a match because (10,33) is in the list.
5. Returns a **zero-length move** `{ path: [(10,33)], fees: ∅, totalFee: 0 }` — bot thinks it arrived at Newcastle.
6. But (10,33) is the ferry port, not the SmallCity. Oil is not available here. The bot's position is saved as (10,33).
7. **Turn 7+**: PlanExecutor sees bot is NOT at Newcastle (actual city check fails), tries `resolveMove("Newcastle")` again. `resolveFerryCrossing` fires from (10,33), teleporting back to (12,46). No track path exists from (12,46) to Newcastle SmallCity → "Move failed, falling back to build" → PassTurn. Bot is permanently stuck.

### Code location

`src/server/services/ai/ActionResolver.ts`

**Lines 1064-1075** (`findCityMilepost`): Returns all grid points with matching `name`, including FerryPort mileposts. Before JIRA-110 this filtered out FerryPort terrain.

**Lines 268-280** (`resolveMove` — `atTargetAfterFerry` check): Compares ferry destination against ALL target positions from `findCityMilepost`, which now includes the ferry port itself. False positive when the ferry port shares a name with the destination city.

## Fix

`findCityMilepost` should distinguish between ferry ports and actual cities. Options:

**Option A (targeted):** In the `atTargetAfterFerry` check, filter `targetPositions` to exclude FerryPort terrain before comparing. The ferry port is transit infrastructure, not a destination where loads can be picked up or delivered.

```typescript
const atTargetAfterFerry = targetPositions.some(
  tp => tp.row === fromPosition.row && tp.col === fromPosition.col
    && grid.get(`${tp.row},${tp.col}`)?.terrain !== TerrainType.FerryPort,
);
```

**Option B (broader):** In `findCityMilepost`, when both a FerryPort and a regular city milepost share the same name, prefer the city milepost for MOVE actions. Only return the FerryPort milepost when no regular city mileposts exist (pure ferry port cities like Dover/Calais).

Option B is more robust — it prevents ferry ports from polluting pathfinding target lists when a real city exists.

## Affected Cities

Any city that has both a SmallCity/MediumCity milepost AND a nearby FerryPort milepost with the same name. Need to audit the grid data for other instances besides Newcastle.

## Regression Risk

Low. The fix narrows the JIRA-110 change to avoid ferry port / city name collisions while preserving the original intent (pure ferry port cities like Dover remain targetable).
