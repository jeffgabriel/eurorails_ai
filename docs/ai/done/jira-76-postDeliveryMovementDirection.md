# JIRA-76: Post-Route-Completion Movement Wastes Mileposts Going Wrong Direction

## Bug Summary

When a mid-turn delivery completes the bot's entire active route, the A2 continuation move in TurnComposer has no strategic direction. The remaining movement budget gets wasted moving in whatever direction the pathfinder defaults to — often the opposite direction of the bot's next-best demand.

## Observed Behavior

Game `000cb369-2a94-4ffd-adf4-42745a9a0fe9`, Turn 10, Haiku bot (`60789b5a`):

1. Bot was executing route: `pickup(Cars@Stuttgart) → deliver(Cars@Berlin)`
2. PlanExecutor produced `MoveTrain` toward Berlin
3. TurnComposer A1 scanner split the move: `[MoveTrain, DeliverLoad, MoveTrain]`
4. After delivery, A2 continuation chained a final `MoveTrain` with remaining budget
5. **Bot left Berlin going in the OPPOSITE direction of Szczecin** (where Potatoes, the #2 ranked demand's supply city, was located)
6. On turn 11, LLM planned route `Potatoes Szczecin→Zurich` — but the bot was now further from Szczecin than it was at Berlin

## Root Cause

`TurnComposer.findMoveTargets()` (line 745) determines the A2 continuation target:

1. **Priority 1**: Active route stops — but after JIRA-69 index advancement, the route is complete (no stops remaining)
2. **Priority 2**: Demand delivery cities on network where bot has the load — but bot just delivered its only load (empty cargo)
3. **Priority 3+**: Falls through to generic demand-based fallbacks that don't consider the bot's *next* route or highest-ranked demand supply city

Since the route is complete and the bot is empty, `findMoveTargets()` has no strategic signal about where the bot should go next. The JIRA-64 re-evaluation (which would plan the next route) runs in AIStrategyEngine *after* TurnComposer finishes composing the turn.

## Impact

- Wastes remaining movement budget (potentially 3-5 mileposts) going the wrong direction
- Adds 1-2 extra turns to reach the next supply city
- Compounds over multiple deliveries throughout the game

## Fix Plan

When a mid-turn delivery completes the entire route (no more stops), `findMoveTargets()` should use the **demand ranking** to identify the best next supply city and move toward it with remaining budget. Specifically:

1. After A2 detects route completion (all stops done), check the `demandRanking` in context
2. Find the highest-ranked demand whose supply city is on the track network
3. Use that supply city as the continuation move target

This gives the bot a "head start" toward its next likely pickup, even though the formal JIRA-64 re-evaluation hasn't run yet.

## Key Files

- `src/server/services/ai/TurnComposer.ts` — `findMoveTargets()` (line 745+), A2 continuation loop (line 258+)
- `src/server/services/ai/AIStrategyEngine.ts` — JIRA-64 post-delivery re-evaluation (runs after TurnComposer)
- `src/server/services/ai/PlanExecutor.ts` — route completion detection

## Related Issues

- JIRA-69: Post-delivery movement waste (fixed mid-turn route sync, but doesn't handle route *completion*)
- JIRA-64: Post-delivery LLM re-evaluation (runs too late to influence same-turn movement)
- JIRA-50: Movement waste A2 chain failure
