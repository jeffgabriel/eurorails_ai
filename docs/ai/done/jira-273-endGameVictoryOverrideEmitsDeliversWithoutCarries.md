# JIRA-273 — End-game victory-route override emits a deliver-only route when the bot does not actually carry the required loads, wedging the bot in an infinite stuck-route-abandon loop

The end-game `findFinalVictoryOutcome` override produces a route consisting entirely of DELIVER stops under the premise that the matching loads are already on the train. When that premise is false, the bot arrives at the first delivery city, the JIRA-249 runtime guard fires (`arrived_for_deliver_but_load_not_carried`), the route is abandoned, and the planner immediately re-emits the same impossible route. The game ends with the bot frozen in this cycle, cash below the victory threshold.

## Source

`logs/game-c73cccf8-919e-462c-8250-28b2199665a4.ndjson`, player s1, turns T242–T249 (and earlier; the cycle starts around T230s). Latest game log on `cac1493`.

## Trace

Same state repeats every turn. Representative T244:

- `action: PassTurn`, `cash: 208M`, `position: (40,59)`
- `activeRoute.stops: [deliver Imports@Budapest, deliver Sheep@Wroclaw]`, `currentStopIndex: 1`
- `a2.terminationReason: arrived_for_deliver_but_load_not_carried`
- `endGame.victoryRouteProjection.appliedOverride: true`
- `endGame.victoryRouteProjection.stops: [deliver:Imports@Budapest, deliver:Sheep@Wroclaw]`
- `endGame.victoryRouteProjection.payoutM: 58` → `cashAtVictory: 266` (above 250M threshold; all 7 majors connected)
- `victoryCheck.outcome: insufficient-funds, netWorth: 208, threshold: 250`

Every 3 turns the stuck-route-abandon fires (`strategy-brain` source, reasoning: `[stuck-route-abandon] no progress for 3 turns`). The route is cleared. Next turn the override re-emits the identical route. Loop continues until the game ends.

## What should happen

The victory-route override must only apply when its carry assumptions match the bot's actual cargo. Two acceptable shapes:

1. **Reject the override when the assumed carries aren't on the train.** Fall back to whatever the regular planner produces — the bot picks up the loads first, then delivers them.
2. **Emit a complete route that includes the necessary pickup stops.** If the bot needs to pick up Imports and Sheep first, the override's route is `[pickup Imports@X, pickup Sheep@Y, deliver Imports@Budapest, deliver Sheep@Wroclaw]`, not just the delivers.

Either shape ends the loop. Today the override projects a winning outcome whose preconditions (loads carried) are never satisfied, and the planner has no recovery path because the override re-applies every replan.

## Related

- **JIRA-249 Layer 3** added the runtime guard that detects "arrived for deliver but load not carried" — that guard is firing correctly here; it's not the bug.
- **JIRA-267** made `findFinalVictoryOutcome` multiplicity-aware for carried loads. This is a different failure mode: the override assumes carries that don't exist at all, not over-counting carries that do.
- **JIRA-261** fixed first-stop-only idempotency of the override comparison. This bug is upstream — the override itself is wrong.
