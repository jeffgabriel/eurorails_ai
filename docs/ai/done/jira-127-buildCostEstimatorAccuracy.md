# JIRA-127: Build Cost Estimator Underestimates Track Construction Costs

_Analysis of game `361153a6`. Haiku bot committed to a route it couldn't afford because the demand ranking's build cost estimates were 3x lower than actual construction costs._

## The Bug

`ContextBuilder.estimateTrackCost()` provides `trackCostToSupply` and `trackCostToDelivery` values in the demand ranking. These estimates feed into the LLM's route selection. When the estimates are significantly wrong, the LLM commits to routes the bot can't afford, leading to cash depletion and the broke/discard spiral.

## The Evidence: Game `361153a6`, Haiku Bot

### T16 Re-Evaluation — Hops Cardiff→Marseille

Demand ranking at T16 (cash=$39M):

| Field | Estimated | Actual | Error |
|-------|-----------|--------|-------|
| `trackCostToSupply` (Cardiff) | $12M | $15M (T16-T17) | 1.25x |
| `trackCostToDelivery` (Marseille) | $10M | $31M (T22-T23) | **3.1x** |
| **Total build cost** | **$22M** | **$46M** | **2.1x** |

The LLM saw a $29M payout with $22M build cost → positive ROI. Reality was $29M payout with $46M build cost → **net loss of $17M**.

### Consequence

| Turn | Cash | Action | Notes |
|------|------|--------|-------|
| T16 | $39M | Build toward Cardiff ($7M) | Route committed based on $22M total estimate |
| T17 | $31M | Build toward Cardiff ($8M) | |
| T22 | $11M | Build toward Marseille ($20M) | Spending last dollar |
| T23 | $0M | Build toward Marseille ($11M) | **Broke** |
| T24 | $0M | PassTurn | Broke, can't build, abandoned route |
| T25-26 | $0M | DiscardHand x2 | Heuristic fallback death spiral |

The bot lost ~10 turns recovering from a route the estimator said was affordable.

## Root Cause Analysis

### `ContextBuilder.estimateTrackCost()` — `ContextBuilder.ts:2406-2599`

The estimator works as follows:

1. **Find nearest existing segment endpoint** to the target city (by hex distance)
2. **Run `estimatePathCost()` Dijkstra** from that single endpoint to the target city
3. Fall back to `hexDistance × 3.0 terrain multiplier` if Dijkstra returns 0

### Why It Underestimates

1. **Single-endpoint estimation vs multi-source reality**: The estimator picks the single closest endpoint by hex distance and runs Dijkstra from there. But `computeBuildSegments` uses multi-source Dijkstra starting from ALL network frontier nodes. The closest endpoint by hex distance may not be the one the build actually starts from.

2. **No budget-per-turn constraint**: `estimatePathCost` Dijkstra finds the cheapest total path. But `computeBuildSegments` is budget-constrained ($20M/turn max). When a path can't be completed in one turn, the second turn's build restarts from the new frontier, potentially taking a suboptimal continuation path. Multi-turn builds accumulate costs that single-pass Dijkstra doesn't model.

3. **Terrain multiplier too low for certain corridors**: The fallback `hexDistance × 3.0` underestimates when routes pass through mountains, cross rivers, or enter expensive cities. Paris→Marseille crosses significant terrain.

### `estimatePathCost()` — `MapTopology.ts:368-427`

This is a terrain-aware Dijkstra that should give accurate costs for a direct path. If it returned $10M for Paris→Marseille, either:
- The nearest endpoint was very close to Marseille (but the bot didn't have track near Marseille at T16)
- The Dijkstra was starting from a misleading "closest" endpoint that's actually far by road

## Expected Behavior

The build cost estimate should be within ~30% of actual build cost. A 3x underestimate causes catastrophic route commitment errors.

## Proposed Fix

1. **Use actual network frontier** for estimation instead of single closest endpoint — run a quick multi-source BFS from all network endpoints to find true nearest-by-cost node to the target
2. **Add budget-per-turn penalty**: If estimated cost > $20M, add a multi-turn overhead factor (e.g., 1.2x per additional turn of building)
3. **Validate estimates against actual costs**: Log estimated vs actual build costs in the game log for ongoing accuracy monitoring

## Files to Modify

| File | Function | Change |
|------|----------|--------|
| `src/server/services/ai/ContextBuilder.ts:2406-2599` | `estimateTrackCost()` | Use network frontier for estimation |
| `src/server/services/ai/MapTopology.ts:368-427` | `estimatePathCost()` | Verify accuracy for long-distance paths |
