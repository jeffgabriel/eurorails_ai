# JIRA-162: calculateTrackRunway measures total network depth instead of directional runway

## Summary

`TurnExecutorPlanner.calculateTrackRunway()` computes `destPosition` but never uses it. The BFS traverses the entire bot network and returns `maxDepthOnNetwork / trainSpeed` — the maximum hop count to ANY node in ANY direction. This inflates the JIT gate's `effectiveRunway` so that `shouldDeferBuild()` permanently defers building once the network exceeds ~18 segments (2 × trainSpeed), creating an infinite oscillation loop.

## Evidence — Game 63431158

| Bot | Stuck from | Duration | Cash | Build target | Network segments | Behavior |
|-----|-----------|----------|------|-------------|-----------------|----------|
| Flash | Turn 17 | 59 turns | 36M | Budapest | ~41 | Oscillates Wien ↔ (44,62) |
| Haiku | Turn 46 | 30 turns | 44M | Zurich | ~91 | Oscillates Stuttgart ↔ Luxembourg |

Both bots have money, a valid build target, and an active route requiring track to an off-network city. The build phase is skipped every turn with `{ target: "Budapest", cost: 0, skipped: true }`.

### Root cause trace

1. `resolveBuildTarget()` correctly identifies the off-network city (e.g., Budapest)
2. `executeBuildPhase()` enters the JIT gate because `useAdvisor = true`
3. `shouldDeferBuild()` calls `calculateTrackRunway(snapshot, "Budapest", 9, context)`
4. `calculateTrackRunway`:
   - Line 1232-1238: Computes `destPosition` for Budapest → **never referenced again**
   - Line 1245-1271: BFS from bot position through ALL network segments
   - Line 1266: Tracks `maxDepthOnNetwork` as maximum BFS depth to any node
   - Line 1273: Returns `maxDepthOnNetwork / trainSpeed` (e.g., 30/9 = 3.3 for Flash)
5. `effectiveRunway = intermediateStopTurns(0) + trackRunway(3.3) = 3.3 >= 2` → **DEFERRED**
6. Build skipped. Route executor moves toward unreachable city, reaches end of track, reverses next turn → infinite loop

## Affected code

**File:** `src/server/services/ai/TurnExecutorPlanner.ts`

**Function:** `calculateTrackRunway()` (lines 1213-1274)

```typescript
// Line 1232-1238: destPosition is computed...
let destPosition: { row: number; col: number } | null = null;
for (const [, gp] of gridPoints) {
  if (gp.name && gp.name.toLowerCase() === destinationCity.toLowerCase()) {
    destPosition = { row: gp.row, col: gp.col };
    break;
  }
}

// Line 1245-1271: ...but the BFS never uses it
let frontier = [{ row: snapshot.bot.position.row, col: snapshot.bot.position.col, depth: 0 }];
let maxDepthOnNetwork = 0;
// BFS traverses ALL connected segments, tracking max depth in ANY direction
```

**Caller:** `shouldDeferBuild()` (line 1154) — uses the inflated runway to permanently defer builds.

## Proposed fix

Replace the undirected BFS with a directional measurement. The function should measure how far the bot's existing track extends **toward** the destination, not the total network size.

**Option A — Directional BFS filter:** Only expand BFS nodes where `hexDistance(neighbor, dest) < hexDistance(currentNode, dest)`. Track `maxDepthOnNetwork` only for nodes that are progressing toward the target.

```typescript
const botDistToDest = hexDistance(
  snapshot.bot.position.row, snapshot.bot.position.col,
  destPosition.row, destPosition.col,
);

while (frontier.length > 0) {
  const nextFrontier: typeof frontier = [];
  for (const node of frontier) {
    const nodeDist = hexDistance(node.row, node.col, destPosition.row, destPosition.col);
    const neighbors = getHexNeighbors(node.row, node.col);
    for (const neighbor of neighbors) {
      // ... existing visited/segment checks ...
      const neighborDist = hexDistance(neighbor.row, neighbor.col, destPosition.row, destPosition.col);
      if (neighborDist >= nodeDist) continue; // Only expand toward destination
      const newDepth = node.depth + 1;
      if (newDepth > maxDepthOnNetwork) maxDepthOnNetwork = newDepth;
      nextFrontier.push({ row: neighbor.row, col: neighbor.col, depth: newDepth });
    }
  }
  frontier = nextFrontier;
}
```

**Option B — Closest-node gap metric:** Find the network node closest to the destination and return `(botDistToDest - closestNodeDist) / trainSpeed` — measuring how much of the gap the existing track covers.

## Secondary bugs surfaced by this game

These are not part of the JIRA-162 fix but were observed in the same game:

1. **No oscillation breaker** — No system detects that the bot has been visiting the same two positions for 30-59 turns. A guardrail should force route replan or hand discard after N unproductive turns.

2. **Stale route never replanned** — Flash holds the same route (Ham → Budapest) for 59 turns. Haiku holds stale demand cards for up to 52 turns. No circuit breaker triggers replanning.

3. **No train upgrades considered** — Neither bot upgrades from Freight despite having 36-44M cash for dozens of turns. The upgrade check is inside the build phase which is being skipped entirely.

4. **Haiku's wasted spur (48,63 → 53,63)** — Build advisor coordinate misreads on turns 19 and 38 created ~31M of dead-end track. Separate from this bug but worth a follow-up.

## Test plan

1. Unit test `calculateTrackRunway` with a bot that has a large network (30+ segments) but the destination is off-network — verify runway reflects directional progress, not total network size
2. Unit test `shouldDeferBuild` with same scenario — verify it returns `deferred: false` when no track extends toward the target
3. Integration test: replay the Flash Turn 17 scenario (41 segments, Budapest off-network, 36M cash) — verify the build advisor fires and produces track toward Budapest
4. Regression test: verify JIT deferral still works correctly when track DOES extend toward the destination (don't break the intended behavior of deferring builds when there's genuine runway)
