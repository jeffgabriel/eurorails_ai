# JIRA-85: Track Building Pathfinding Optimization

## Problem (Observed in Game 48c2c1aa)

The bot builds track inefficiently in three observable ways:

1. **City overshoot**: The bot overshoots target cities. In Milano, it could have connected at the NW corner but instead built past the city to the south, left an unused spur, and connected at the SW. Same issue at Zurich.

2. **Expensive route selection**: The bot built through Ruhr→Frankfurt (expensive, longer) when a spur off Luxembourg would have been cheaper and shorter total distance.

3. **No full-path awareness**: The bot only evaluates "how close did I get this turn" rather than "what's the cheapest complete route to my target."

## How a Human Builds Track

A human player building track toward a city:

1. **Traces the full route mentally** — looks at the entire path from their track frontier to the target city, even if it takes 2-3 turns to complete
2. **Evaluates alternate routes by total cost** — considers terrain (mountains cost 2M, alpine costs 5M, clear costs 1M) and water crossings along the entire path, not just the next 20M chunk
3. **Picks the cheapest viable full route** — even if the first turn's segment is slightly farther from the target by straight line, the total multi-turn cost is lower
4. **Builds the first budget-worth of that route** — spends up to 20M building the opening segments of the chosen full path
5. **Continues the same path next turn** — doesn't re-evaluate from scratch; follows through on the planned route

Key insight: a human balances cost and distance *across the full route*, not within a single turn.

## How the Bot Currently Builds (Broken)

1. Runs multi-source Dijkstra from ALL track positions (not just frontier) outward, expanding by terrain cost, until the entire budget-reachable graph is explored
2. For each reachable endpoint, measures straight-line **hex distance** to the target city
3. Picks the endpoint closest to target by hex distance; ties broken by most segments built, then cheapest
4. extractSegments picks the longest contiguous run of new track from that path
5. Next turn, starts from scratch with a new Dijkstra from the updated frontier

### Why this fails

- **Hex distance is blind to terrain**: A path ending 4 hexes from the target through mountains may *look* closer than a path ending 5 hexes away through clear terrain, but the mountain path costs 8M more to complete next turn. The bot picks the "closer" mountain path.
- **No early termination**: Dijkstra explores past the target city, so the bot finds paths that go *through* the target and out the other side. extractSegments then picks the longest run from that path, which may overshoot the city.
- **No full-route planning**: The bot doesn't compute "what would the complete route cost from my frontier to the target." It only knows "how close can I get within 20M this turn."
- **Longest run ≠ best run**: extractSegments always picks the longest contiguous run of new segments. If the path goes through the target and out the other side, the longest run may be the one past the target.

## Proposed Solution — Behavioral Description

### What changes for the bot

**Before**: "Explore everything reachable within 20M, pick the endpoint closest to target by straight-line distance, build as many segments as possible toward it."

**After**: "Compute the cheapest complete route from my frontier to the target city (ignoring budget). Build the first 20M chunk of that route. Stop at the target if I reach it."

### Concrete behavior changes

1. **Full-path Dijkstra to target**: Instead of exploring the entire budget-reachable graph and scoring by hex distance, run Dijkstra from the track frontier with early termination at the target city. This finds the cheapest *complete route* to the target — the same route a human would trace mentally.

2. **Build the first budget-worth**: Take the cheapest full path to the target, then truncate it to what fits within 20M budget. This means the bot builds the *opening segment of the optimal route*, even if a different path would get "closer" this turn by hex distance.

3. **Stop at target**: If the budget is enough to reach the target city, Dijkstra stops there. No overshoot. The path ends at the target milepost, not past it.

4. **Continuation follows the same path**: Because the bot builds the first chunk of the cheapest full path, next turn's Dijkstra will naturally continue along the same corridor (the frontier is now at the end of that chunk, and the cheapest path from there is the remainder of the same route).

### Example: Luxembourg vs Ruhr

**Before**: Bot's Dijkstra explores outward 20M from the frontier near Luxembourg. It finds an endpoint near Frankfurt (via Ruhr) that is 3 hexes from the target, and an endpoint on a Luxembourg spur that is 4 hexes from the target. Picks Ruhr→Frankfurt because 3 < 4 hex distance. Total route cost: ~35M across 2 turns.

**After**: Bot computes cheapest full path from frontier to target. Luxembourg spur route: total 22M. Ruhr→Frankfurt route: total 35M. Bot picks Luxembourg route. Builds first 20M this turn. Next turn, spends 2M to complete. Total: 22M.

### Example: Milano overshoot

**Before**: Dijkstra explores past Milano. Path goes through Milano NW corner, continues south, creates a spur. extractSegments picks the longest run (past Milano). Bot builds past the city.

**After**: Dijkstra terminates when it reaches any Milano milepost. Path ends at the NW corner (cheapest entry point). extractSegments has no overshoot to select. Bot connects to Milano directly.

## Key Architectural Insight

The fundamental fix is changing from **"explore within budget, score by hex distance"** to **"find cheapest full path to target, truncate to budget."** This is still Dijkstra — we just remove the budget cap during exploration (or set it very high) and add early termination at the target. The budget constraint moves from "how far can I explore" to "how much of the optimal path can I build this turn."

This also means the tiebreaker changes are less important — if we're building the first chunk of the cheapest full path, there's no need to score endpoints by proximity. The path IS the cheapest route to the target; we just take as much of it as we can afford.

## Impact on Existing Features

- **JIRA-73 continuation builds**: Still work — after building the primary path chunk, continuation builds can spend remaining budget on secondary route stops
- **Ferry waypoint logic**: Unchanged — cross-water target detection still redirects to departure ports
- **Cold-start builds**: Unchanged — Dijkstra sources remain major city mileposts when no track exists
- **Dead-end pruning**: Unchanged — still skips peninsula mileposts

## Files Affected

- `src/server/services/ai/computeBuildSegments.ts` — primary changes (Dijkstra loop, path selection, extractSegments)
- `src/server/__tests__/computeBuildSegments.test.ts` — new test cases for overshoot, route cost optimization
