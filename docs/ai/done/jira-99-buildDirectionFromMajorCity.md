# JIRA-99: Build Track Outward From Major Cities to Save 5M

## Problem

The bot builds track FROM its existing network TOWARD major cities. The final segment into the major city costs 5M (major city milepost cost). This is wasteful because the game rules allow players to start building from any major city milepost for free — building outward from the major city avoids paying the 5M entry cost entirely.

### Rule Clarification

From the EuroRails rulebook:
- "A player may start building track from: Any major city milepost, OR Any milepost already connected to the player's track."
- "The player must pay the cost of the milepost they are building to."
- "A player cannot build more than 2 track sections from a major city milepost in one turn."
- Drawing into a major city is rare — players typically draw out of each major city.

### Cost Impact

Building the same path between a major city and the bot's network:
- **Current (INTO major city):** intermediate mileposts + 5M for the major city = total cost includes 5M city entry
- **Correct (OUT FROM major city):** intermediate mileposts only = saves 5M per major city connection

This is 25% of the per-turn 20M build budget. Over a game where the bot connects 7+ major cities, this wastes 35M+ in unnecessary track costs.

### Example

Bot has track at milepost A. Needs to connect to Berlin (major city at milepost B). Path A→B has 4 clear terrain mileposts between them.

- **Current:** Build from A toward B. Cost: 4×1M + 5M (Berlin) = 9M
- **Correct:** Build from B (Berlin) toward A. Cost: 4×1M + 0M (started at Berlin) = 4M. Savings: 5M

Note: The bot can build from both directions in the same turn — extend from its network AND extend from the major city — as long as the total spend ≤ 20M.

## Fix

Modify `computeBuildSegments` (or the pathfinding cost model it uses) to:
1. When the build target is a major city, start the build path FROM the major city outward toward the bot's network
2. When the build target is NOT a major city but passes through one, consider starting from the major city to avoid the 5M entry cost
3. Respect the 2-section-per-turn limit from major city mileposts

## Files to Investigate

- `src/server/services/ai/computeBuildSegments.ts` — main track building pathfinding
- `src/server/services/ai/PlanExecutor.ts` — where build targets are selected and segments are computed
- `src/server/services/ai/TurnComposer.ts` — Phase B build logic
- `src/server/services/ai/MapTopology.ts` — terrain cost calculations, Dijkstra pathfinding
- `src/server/services/ai/ContextBuilder.ts` — `estimateTrackCost()` may also assume building INTO cities
