# JIRA-58: Build Targeting Selects Delivery City Without Supply Access

## Bug Description

The build target selection logic picks a delivery city as the build target even when the bot has no access to the corresponding supply city. This wastes track budget on a route the bot cannot use until it also builds to the supply city.

## Evidence

Game `ff240679`, Haiku (claude-haiku-4-5-20251001):

- **Turn 4**: Haiku picks up Steel at Ruhr, moves 9 mileposts toward Wroclaw. Build phase targets **Lodz** at cost 7M.
- Demand ranking shows `Cattle Bern→Lodz` as rank 2 (score 1.08). Lodz is the delivery city; Bern is the supply city at 16M track cost away.
- Haiku built 7M of track toward Lodz but **never pursued the Cattle demand** — by Turn 7 it switched to Labor Zagreb→Stuttgart.
- The 7M track to Lodz was never traversed.

## Root Cause

The build target selector picks cities based on demand ranking and proximity to the existing network. Lodz was cheap to reach (7M) because Haiku's track already extended eastward from the Ruhr-Berlin-Wroclaw corridor.

However, the selector didn't consider that:
1. Lodz is a **delivery** city, not a supply city
2. The supply city (Bern) requires 16M of additional track
3. Total investment to actually use this route = 7M (Lodz) + 16M (Bern) = 23M, which exceeds the 20M/turn budget and is close to the 24M payout — poor ROI

## Affected Files

- Build target selection logic (likely in `TurnComposer.ts` or `ContextBuilder.ts` — need to trace where `buildTargetCity` is determined)

## Fix

When scoring build targets, penalize delivery cities where the corresponding supply city is not yet reachable. Either:
1. Only build toward supply cities when the delivery city is already reachable (or vice versa)
2. Factor in the total supply+delivery track cost when evaluating whether to build toward a demand's delivery city
3. Prefer building toward the supply city first if neither is reachable
