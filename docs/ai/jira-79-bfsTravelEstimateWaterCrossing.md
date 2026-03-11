# JIRA-79: BFS Travel Estimate Returns 0 for Water-Separated Routes

## Bug Summary

`estimateHopDistance()` in `MapTopology.ts` performs a BFS across hex grid tiles but skips all Water terrain tiles (line 423: `if (nbData.terrain === TerrainType.Water) continue;`). This means any route that requires crossing water (ferries between Ireland/Britain/Scandinavia/mainland Europe) returns 0 hops ("unreachable").

`ContextBuilder` (line 573-587) only adds to `travelTurns` when `dist > 0`. When BFS returns 0 for water-separated routes, `travelTurns` stays at 0, producing wildly underestimated `estimatedTurns`.

## Observed Behavior

Game `9126f0b3`, Turn 11, Haiku bot (94b6428f):
- Sheep (Cork) -> Beograd ranked #1 with estimatedTurns=4
- Actual calculation: buildTurns=ceil(51M/20M)=3, travelTurns=0 (BFS can't cross water), +1 buffer = 4
- Cork is in Ireland, Beograd is in Serbia -- this is a massive cross-map route that would realistically take 10+ turns
- Bot had only 33M cash with trackCostToSupply=41M -- already unaffordable
- The artificially low estimatedTurns inflated demandScore, making it rank #1

## Impact

- ALL demands involving Ireland, Britain, Scandinavia, or any water-separated region get artificially low turn estimates
- These demands get inflated demandScore and are ranked highly when they're often terrible choices
- Bots pick cross-map ferry routes that bankrupt them
- Affects demand scoring, route planning, and build targeting

## Root Cause

1. `MapTopology.ts:estimateHopDistance()` line 423: `if (nbData.terrain === TerrainType.Water) continue;` -- BFS skips water tiles entirely
2. `ContextBuilder.ts` line 573-587: When BFS returns 0 (unreachable), the `if (minDist < Infinity)` check fails, and `travelTurns` stays at 0 instead of being set to a large fallback value
3. The +1 buffer and buildTurns still get added, producing a small but completely wrong estimate

## Fix Plan

Two complementary fixes:

### Fix A: Fallback distance when BFS returns 0

In ContextBuilder, when `estimateHopDistance` returns 0 or minDist stays at Infinity for a route that has valid supply/delivery cities, use a Euclidean/Manhattan distance fallback on the hex grid coordinates to produce a rough travel estimate. This ensures water-separated routes get a reasonable (if imprecise) travel time.

### Fix B (optional, larger scope): Make BFS ferry-aware

Add ferry connections to the BFS graph in MapTopology so `estimateHopDistance` can traverse water via known ferry ports. This is more accurate but higher complexity -- the ferry port data would need to be loaded into the grid graph.

## Key Files

- `src/server/services/ai/MapTopology.ts:399-435` -- `estimateHopDistance()` BFS, line 423 skips water
- `src/server/services/ai/ContextBuilder.ts:535-589` -- `estimatedTurns` calculation
- `src/shared/types/GameTypes.ts` -- TerrainType enum including Water
