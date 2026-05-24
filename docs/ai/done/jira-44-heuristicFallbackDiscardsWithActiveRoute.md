# JIRA-44: Heuristic Fallback Defaults to DiscardHand When LLM Call Fails with Active Route

**Severity:** High
**Source:** Game `aaf1bb82` analysis — Flash (gemini-3-flash-preview) T7

## Problem

When the LLM planning call fails (timeout or error), the heuristic-fallback path issues a DiscardHand action even when the bot has an active route in progress. This wastes the entire turn and destroys the current hand, when the bot should instead continue executing its existing plan.

The fallback should NOT treat PassTurn as viable either when there is an active plan in place, unless the train has run out of track to traverse.

## Fallback Priority (when active route exists)

1. Continue the active route (MoveTrain toward next stop)
2. BuildTrack if the route needs track built
3. PassTurn ONLY if the train has run out of reachable track
4. DiscardHand should be last resort, only when no route exists AND hand is poor

## Evidence — Game `aaf1bb82`, Flash T7

- Flash had just delivered Cheese at T6 and had 3M cash
- LLM call failed at T7 (took 112 seconds, timed out)
- `heuristic-fallback` issued DiscardHand, wasting 9 mileposts of movement
- Flash had demand cards it could have pursued (Hops Cardiff→Munchen 29M, China Birmingham→Toulouse 26M)
- The discard destroyed these demands and left Flash with 3M and no plan
- Flash never recovered — entered a 0M cash death spiral from T8 onward

## Root Cause

The heuristic-fallback in PlanExecutor/AIStrategyEngine does not check for an active route before defaulting to DiscardHand. It should attempt to continue route execution first, falling back to DiscardHand only when truly stuck.

## Files

- `src/server/services/ai/AIStrategyEngine.ts` (heuristic fallback logic)
- `src/server/services/ai/PlanExecutor.ts` (fallback action selection)
