# JIRA-158: Post-Delivery Replan Uses Stale Context & Route Persists After Completion

**Game:** `9ea6a2d6-3a4e-4c53-9a73-fd8fe8d38c4f`
**Bot:** Haiku
**Branch:** `compounds/guardrail-updates`

---

## Bug A: TripPlanner post-delivery replan uses stale demand context

**Severity:** High — bot wastes turns on an already-fulfilled demand
**Observed:** Haiku turn 6

**Symptom:** After delivering Beer to Beograd, TripPlanner is called for a post-delivery replan but its context still shows `Card 113: Beer from OnTrain → Beograd (17M)` — the demand card that was just fulfilled. The LLM picks the stale Beer demand (8.5M/turn efficiency) over the Oil→München demand (1.4M/turn efficiency) because the stale demand appears far more attractive.

**Root cause:** The post-delivery replan inside `TurnExecutorPlanner.execute()` (lines 264-286) calls `TripPlanner.planTrip(snapshot, context, ...)`. But `context.demands` still reflects the start-of-turn state — the delivered demand card hasn't been removed. The actual demand card draw/replacement happens later in `TurnExecutor` (DB execution layer), not during the planning phase.

The JIRA-157 fix made `context.bot.loads` mutable after delivery, but `context.demands` and `snapshot.bot.resolvedDemands` are still stale during the mid-loop replan.

**Fix:** Before calling `TripPlanner.planTrip()` in the post-delivery replan (TurnExecutorPlanner.ts ~line 268), filter out the just-delivered demand from `context.demands` and `snapshot.bot.resolvedDemands`. Alternatively, mark the demand as fulfilled so TripPlanner won't select it.

---

## Bug B: Stale route persists in BotMemory after route should be cleared

**Severity:** High — bot follows a completed/invalid route on the next turn instead of planning a new one
**Observed:** Haiku turn 7

**Symptom:** Turn 7 shows `activeRoute = pickup(Beer@OnTrain) → deliver(Beer@Beograd)` with `currentStopIndex: 0` and reasoning `[route-executor]`. The Beer demand card no longer exists (replaced by Oil→Ruhr on turn 6). The bot enters the `else if (activeRoute)` branch and follows the stale route.

**Root cause:** On turn 6, TripPlanner returned the stale Beer→Beograd route. TurnExecutorPlanner executed it (delivery happened mid-loop). During post-delivery replan, TripPlanner returned the SAME stale Beer→Beograd route again. `skipCompletedStops` tried to advance but the first stop is `pickup(Beer@OnTrain)` — "OnTrain" is not a city, so the stop isn't detected as complete by `isStopComplete`. The loop terminates with `stop_city_not_on_network`, NOT `route_complete`.

Back in AIStrategyEngine line 591: `activeRoute = execResult.updatedRoute` — the stale route is saved.

The JIRA-64 orphan check at line 917 SHOULD clear it (Beer is no longer in demands), and the NDJSON log shows `activeRoute: null` for turn 6. However, on turn 7, the route reappears. This suggests either:
1. The JIRA-64 check didn't actually fire (perhaps `hadDelivery` was false at line 912)
2. The `updateMemory` shallow merge has a timing issue
3. There's a second write path that restores the route

**Investigation needed:** Add debug logging to `updateMemory` and the JIRA-64 orphan check to trace exactly what's happening between turns 6 and 7.

---

## What Should Have Happened

After delivering Beer at Beograd on turn 6:
1. The Beer demand card is discarded, a new card is drawn (Oil→Ruhr)
2. Post-delivery replan should see fresh demands: Oil→München (19M), Oil→Ruhr (18M), Imports→Budapest (25M)
3. TripPlanner should plan: `pickup(Oil@Beograd) → deliver(Oil@Ruhr) → pickup(Oil@Beograd) → deliver(Oil@München)` or similar corridor
4. Turn 7 should execute the new Oil route

## Good News: JIRA-157 Fixes Working

The Bug C/D fixes from JIRA-157 are confirmed working:
- Turn 6 `outputPlan: [MoveTrain, DeliverLoad, MoveTrain]` — bot moved, delivered, and continued in the same turn
- Exactly 1 delivery (not 20x)
- No wasted mileposts
