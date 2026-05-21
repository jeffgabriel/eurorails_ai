# JIRA-66: estimatedTurns Wildly Optimistic for Cross-Map Routes

## Bug Description

The `estimatedTurns` calculation in demand scoring significantly underestimates turn counts for long cross-map journeys, causing the bot to commit to demands that take 2x longer than projected. This leads to long stretches with zero income while the bot travels.

## Evidence

### Game `be09cd45`, Flash, T20:
- **Demand:** Ham from Warszawa to Roma, 35M payout
- **Estimated turns:** 6 (ranked #1 with efficiency 5.00/turn)
- **Actual turns:** 11+ (T20-T31, still not delivered when log ends)
  - T20: BuildTrack toward Warszawa
  - T21-T23: Moving toward Warszawa (3 turns)
  - T24: DiscardHand mid-route (wasted turn)
  - T25-T26: Moving toward Warszawa (2 turns, finally picked up)
  - T27-T31: Moving toward Roma (5 turns, still not arrived)
- **Result:** Flash's cash was frozen at 39M for 11 turns with zero income

The estimate of 6 turns was based on a straight-line or network distance that didn't account for the actual path through central Europe (Warszawa → through Poland/Czech/Austria → down through Italy to Roma).

## Root Cause

`ContextBuilder.scoreDemand()` computes `estimatedTurns` using track distance estimates that likely use:
- Euclidean or Manhattan distance between cities
- Simplified network hop counts
- Without accounting for the bot's movement speed (9 mp/turn for Freight) relative to actual path length through the grid

For short routes this is close enough, but for cross-map routes (Warszawa→Roma = ~40+ mileposts through mountains and cities), the error compounds dramatically.

## Fix

Improve `estimatedTurns` calculation:
1. Use actual shortest path distance through the grid (via BFS/Dijkstra on the milepost graph) rather than estimates
2. Account for existing track so that the projected travel path is cost-effective - essentially plan the most likely build path and then count the spaces.
3. Divide by the bot's actual movement speed (accounting for train type)
4. Add +1 turn buffer for pickup/delivery actions

## Affected Files

- `src/server/services/ai/ContextBuilder.ts` — `scoreDemand()` and `estimatedTurns` computation
- `src/server/services/ai/MapTopology.ts` — may need shortest-path utility

## Impact

A 2x overestimate on turn count means the efficiency calculation (`payout / estimatedTurns`) is 2x too optimistic. Flash committed 11+ turns (zero income) to a demand scored as a 6-turn job. Better estimates would have ranked shorter, more achievable demands higher.
