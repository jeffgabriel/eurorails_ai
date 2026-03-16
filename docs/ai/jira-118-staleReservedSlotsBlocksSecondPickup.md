# JIRA-118: Stale reservedSlots Blocks Second Opportunistic Pickup

## Summary
When a bot has two demand cards for the same load type sourced from the same city (e.g., Cattle from Bern → Ruhr and Cattle from Bern → Lodz), the A1 opportunistic scanner in `splitMoveForOpportunities()` only picks up one copy instead of two because the `reservedSlots` counter is never decremented after the planned pickup is consumed.

## Observed Behavior
- Game `7bf86af8`, Haiku bot, turn 5
- Bot had two Cattle demands: Cattle→Ruhr (19M) and Cattle→Lodz (24M), both sourced from Bern
- Active route: `pickup(Cattle@Bern) → deliver(Cattle@Ruhr)`, currentStopIndex=0
- Train capacity: 2 (Freight), carried loads: 0
- Bot passed through Bern and picked up only 1 Cattle
- Second Cattle was never attempted despite capacity and matching demand

## Expected Behavior
Bot should pick up 2 Cattle at Bern — one for the planned route and one opportunistically for the second demand card.

## Root Cause
In `TurnComposer.splitMoveForOpportunities()`:

1. `reservedSlots` is computed once at the top of the method (lines 540-546), counting consecutive pickup stops from `currentStopIndex`. For this route, `reservedSlots = 1`.
2. `effectiveCapacity = trainCapacity - reservedSlots = 2 - 1 = 1`
3. The planned stop enforcement (lines 560-574) executes `pickup(Cattle@Bern)` and advances `currentRoute.currentStopIndex` to 1, but does NOT decrement `reservedSlots`.
4. The A1 opportunistic scanner (lines 612-678) then checks for additional pickups. But `snapshot.bot.loads.length (1) >= effectiveCapacity (1)`, so the while loop never enters.
5. The 2nd Cattle pickup is blocked by a stale reservation that was already fulfilled.

## Fix
Decrement `reservedSlots` when the planned stop enforcement at lines 560-574 consumes a pickup stop. This frees up the capacity slot for opportunistic pickups of the same or different load types.

## Files
- `src/server/services/ai/TurnComposer.ts` — `splitMoveForOpportunities()` method

## Secondary Issue
The LLM route planner only created a single-demand route (`pickup(Cattle@Bern) → deliver(Cattle@Ruhr)`) instead of batching both Cattle demands from Bern. This is a route planning quality issue but is mitigated by the A1 opportunistic scanner — once the reservedSlots bug is fixed.
