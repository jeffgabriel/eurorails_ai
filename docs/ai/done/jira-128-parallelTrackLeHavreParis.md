# JIRA-128: Parallel Duplicate Track Built Between Le Havre and Paris

_Analysis of game `361153a6`. Haiku bot built parallel track segments between Le Havre and Paris, wasting build budget on redundant construction._

## The Bug

The bot built two separate tracks through the Le Havre → Paris corridor, creating parallel/duplicate segments. This wastes build budget — track that should cost $X is effectively costing $2X because the bot builds a second path alongside its own existing track.

## The Evidence: Game `361153a6`, Haiku Bot

### Build Timeline in the Le Havre-Paris Corridor

| Turn | Target | Cost | Segments | Notes |
|------|--------|------|----------|-------|
| T16 | Cardiff | $7M | 4 segs | Route: Hops Cardiff→Marseille. Building NW from Paris toward Channel ferry via Le Havre |
| T17 | Cardiff | $8M | 4 segs | Continuing toward Cardiff — same corridor, different path? |
| T22 | Marseille | $20M | 15 segs | Building south from Paris area toward Marseille |
| T23 | Marseille | $11M | 9 segs | Continuing toward Marseille |

Total build cost for this route: **$46M** for a **$29M payout**.

### Parallel Track Observation

The user observed parallel Haiku-owned tracks between Le Havre and Paris on the game board. This means `computeBuildSegments` built new segments alongside existing Haiku track in the same corridor on a subsequent turn, rather than traversing the existing track for free.

## Root Cause Analysis

### Existing Protections (That Should Have Prevented This)

1. **`computeBuildSegments` — `computeBuildSegments.ts:273-406`**
   - Builds a `builtEdges` set from `existingSegments`
   - Dijkstra skips already-built edges and traverses on-network nodes for free
   - This SHOULD prevent rebuilding along existing track

2. **`NetworkBuildAnalyzer.detectParallelPath()` — `ActionResolver.ts:263-296`**
   - Post-build validation detects parallel paths and reroutes
   - Only runs per-call (within a single turn's build computation)

3. **`NetworkBuildAnalyzer.detectRegionDuplication()` — `ActionResolver.ts:301-330`**
   - Catches dense clusters of duplicate building
   - Suggests waypoints through existing track regions

### Why Protections Failed — Hypotheses

1. **Multi-source Dijkstra start positions**: `computeBuildSegments` starts from multiple source positions (network frontier + train position). If the train moved between T16 and T17 (train went from (47,26)→(51,21) at T16, then (51,21)→(45,27) at T17), the Dijkstra may have found a different optimal path from the new start position that runs parallel to the T16 segments.

2. **Build target direction change**: T16-T17 built toward Cardiff (northwest). The `resolveBuild` function computes a path from the network toward the target. If the starting network node changed between turns (because the train moved), the Dijkstra could find a geographically parallel but topologically distinct path through the Le Havre area.

3. **Parallel path detection threshold**: `NetworkBuildAnalyzer.detectParallelPath()` may have a distance threshold that doesn't catch paths that are "close but not overlapping" — the hex grid allows multiple non-intersecting paths through the same corridor that are only 1-2 hexes apart.

4. **`builtEdges` scope**: The `builtEdges` set prevents rebuilding the EXACT same edge (A→B), but doesn't prevent building a parallel edge (A→C where C is adjacent to B). Two paths can run parallel through a corridor without sharing any edges.

## Expected Behavior

When building toward a target that requires passing through a corridor where the bot already has track, the build should JOIN the existing track and continue from the frontier, not build a parallel path alongside it.

## Proposed Fix

1. **Corridor-aware pathfinding**: Before building, detect if the proposed path runs within N hexes of existing track for M+ consecutive segments. If so, force the path through the nearest existing track node.

2. **Strengthen parallel detection**: `detectParallelPath` should check not just edge overlap but proximity — flag paths where proposed segments are within 1-2 hexes of existing segments for 3+ consecutive steps.

3. **Unified build frontier**: Instead of using train position as an additional start point, always start builds from the network frontier only. The train's current position shouldn't bias the pathfinding toward creating a new branch when existing track nearby leads to the same destination.

## Files to Investigate

| File | Function | Relevance |
|------|----------|-----------|
| `src/server/services/ai/computeBuildSegments.ts:188-574` | `computeBuildSegments()` | Multi-source Dijkstra — check how start positions affect parallel paths |
| `src/server/services/ai/ActionResolver.ts:263-331` | `resolveBuild()` post-build validation | Parallel path detection may need tighter thresholds |
| `src/server/services/ai/NetworkBuildAnalyzer.ts` | `detectParallelPath()`, `detectRegionDuplication()` | Detection logic may miss corridor-level parallelism |
| `src/server/services/ai/ActionResolver.ts:112+` | `resolveBuild()` start position selection | Train position as start may cause divergent paths |
