# JIRA-50: Movement Waste — A2 Continuation Loop Fails to Chain Additional Movement

**Severity:** Medium
**Source:** Game `a5766427` analysis — Flash (gemini-3-flash-preview) T6

## Problem

After completing an action (PICKUP or DELIVER), the A2 continuation loop in TurnComposer failed to chain additional MOVE steps, leaving 6 of 9 mileposts unused. The bot used only 3 MP when it had 9 available, wasting over half its movement budget.

## Evidence — Game `a5766427`, Flash T6

- Flash completed an action consuming 3 MP
- A2 loop should have chained MOVE steps for the remaining 6 MP
- No additional movement was appended
- The turn ended with 6 MP wasted

## Evidence — Game `2d3d214b`

**Flash T11:** Used 1 of 9 mileposts (8 wasted, 11% efficiency). Heuristic-fallback prioritized building 18 segments toward Bilbao over moving. The composition shows `a3.movePreprended=true` but only 1 MP was consumed.

**Flash T18:** Used 1 of 9 mileposts (8 wasted). Bot was moving toward Lyon but hit the end of its track after 1 milepost. No build was attempted to extend the track despite having a clear destination.

**Flash T19-T20:** 0 of 9 mileposts used on both turns (18 MP wasted). Bot had 0M cash so couldn't pay track fees or build, but also couldn't move on its own track — likely a position/pathfinding issue.

**Haiku T13 (Valencia):** Used 2 of 9 mileposts (7 wasted, 22% efficiency). Delivered Tourists and picked up Oranges but stopped moving with 7 MP remaining. Could have started heading toward Münch immediately.

## Expected Behavior

The A2 continuation loop should chain MOVE steps after PICKUP/DELIVER actions until the movement budget is exhausted or the bot reaches its next destination. Wasting more than 1-2 MP per turn (due to milepost alignment) is a sign the loop isn't firing.

## Possible Causes

- A2 loop exit condition triggered prematurely
- Route/destination not set after the action, so A2 has no target to move toward
- Movement budget calculation error after the initial action

## Files

- `src/server/services/ai/TurnComposer.ts` (A2 continuation loop — lines ~250-330)
