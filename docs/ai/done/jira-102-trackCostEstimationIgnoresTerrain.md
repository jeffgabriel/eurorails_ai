# JIRA-102: Track Cost Estimation Ignores Terrain Multipliers

## Problem

The demand ranking's track cost estimator produces wildly inaccurate estimates for routes through expensive terrain. This poisons every downstream decision — the LLM picks bad routes because they look cheap, RouteValidator may approve them, and the bot commits to routes it can't afford.

### Example: Game c9736f59, T5 (player aa9b65d8 "flash")

Demand ranking for Marble@Firenze → Lodz:
- `trackCostToSupply: 7` (Wien → Firenze)
- `trackCostToDelivery: 3` (Warszawa → Lodz)
- Total estimated: ~$10M

Actual build cost: $38M+ (28 segments through Alpine terrain at up to 5M/segment). The estimate was off by ~5x.

## Root Cause

The cost estimator likely uses hop count or straight-line distance without terrain multipliers. Alpine terrain costs 5M/segment, mountains cost 2M, rivers add 2M — these multipliers are not reflected in the estimates.

## Impact

This bad estimate cascades into every downstream decision:
- LLM picks Firenze route because it looks cheap (score=1.05, rank 1)
- RouteValidator may approve it based on the bad estimate
- The bot commits to a route it can't afford
- Combined with JIRA-100 (double build), this bankrupts the bot

## Additional Issue: Destination City Cost Not Included

The build estimate also fails to include the cost of connecting to the destination city itself. Major cities cost 5M, medium/small cities cost 3M — this cost is omitted from the estimate entirely. For a route ending at a major city, this alone understates the cost by 5M.

## Expected Behavior

Track cost estimates should:
1. Use actual terrain costs from the map data, not hop counts. The estimate doesn't need to be exact (Dijkstra is expensive), but it should at least apply average terrain cost multipliers for the region between source and destination.
2. Include the cost to connect to the destination city (5M for major cities, 3M for medium/small cities) in the build estimate.

## Files to Investigate

- `DemandScoring.ts` or equivalent — where `trackCostToSupply` and `trackCostToDelivery` are calculated
- Map topology data — terrain types between cities
