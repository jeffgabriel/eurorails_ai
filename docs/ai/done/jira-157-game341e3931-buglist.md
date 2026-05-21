# JIRA-157: Game 341e3931 Bug List

**Game:** `341e3931-e36f-4a82-aa04-2376cfe36689`
**Bots:** Haiku, Nano
**Branch:** `compounds/guardrail-updates`
**Log:** `logs/game-341e3931-e36f-4a82-aa04-2376cfe36689.ndjson`

---

## Bug A: Initial build turn 2 skips InitialBuildPlanner

**Severity:** High — wastes an entire build turn
**Observed:** Both Haiku and Nano on turn 3 (second initial build turn)
**Symptom:** Toast shows `move_failed_fallthrough_build`. Nano gets `PassTurn` and builds nothing.

**Root cause:** `AIStrategyEngine.ts:270` guards with:
```ts
if (!activeRoute && context.isInitialBuild)
```
On the second initial build turn, `activeRoute` exists (persisted from turn 1 via BotMemory), so the bot falls into the `else if (activeRoute)` route-executor branch at line 321. TurnExecutorPlanner tries Phase A movement with no train position, fails, and falls through to Phase B build — but with the wrong reasoning and potentially wrong build target.

**Fix:** Change the condition to always use the initial-build-planner path when `context.isInitialBuild` is true:
```ts
if (context.isInitialBuild) {
```

---

## Bug B: InitialBuildPlanner picks Bern over Holland for Cheese→Berlin

**Severity:** Medium — suboptimal route selection wastes turns and ECU
**Observed:** Haiku turn 2

**Symptom:** Haiku plans `Steel(Ruhr→Brux) + Cheese(Bern→Berlin)` despite Holland being right next to Bruxelles and Ruhr. From NDJSON pairing data:

| Pairing | Build Cost | Est. Turns | Efficiency | Pairing Score |
|---------|-----------|------------|------------|---------------|
| Steel(Ruhr→Brux) + Cheese(**Bern**→Berlin) | 25M | 8 | -1.12 | -112.5 |
| Cheese(**Holland**→Berlin) + Steel(Ruhr→Brux) | 29M | 7 | -1.86 | -185.7 |

The 25M build cost for the Bern pairing is wrong — it's underestimated.

**Root cause:** `scorePairing()` (line 410) reuses `second.buildCostSupplyToDelivery` from the single-option evaluation, but that value was computed from a different starting city.

The Bern single option was evaluated with `startingCity: Berlin`, so `buildCostSupplyToDelivery = 0` (Berlin to Berlin is free). The chain formula blindly reuses this zero:
```
chainedSecondCost = costBetween(Bruxelles, Bern) + 0 = ~15M
totalBuildCost = 10 + min(22, 15) = 25M  ← should be ~35M+ (Brux→Bern→Berlin)
```

The planner also doesn't model track reuse through hub cities. The optimal path is `Ruhr→Brux→Holland→(back through Ruhr on existing track)→Berlin`, reusing already-built track.

**Fix:** Recalculate `supply→delivery` cost fresh in the pairing's chain context (from second supply to second delivery directly). Don't reuse the single-option field computed from a different starting city. Consider hub routing for track reuse.

---

## Bug C: Immutable context causes `moved_toward_stop` break — wastes remaining movement budget

**Severity:** High — wastes mileposts every turn a bot arrives at a destination mid-move
**Observed:** Haiku turn 4 — picks up Steel at Ruhr, moves 6 mileposts to Bruxelles, arrives with 3 budget remaining, but breaks out of the loop instead of delivering.

**Symptom:** `composition.moveBudget = { total: 9, used: 6, wasted: 0 }` but 3 mileposts are effectively wasted. Delivery is delayed to turn 5.

**Root cause:** `TurnExecutorPlanner.ts:333-339` — after a MoveTrain, the loop breaks because `context.position` is read-only (reflects start-of-turn state). The code has a NOTE comment acknowledging this should be a `continue` once context is mutable:
```ts
// NOTE: In a future iteration when context is mutable mid-turn, this can be
// replaced with a continue to execute the action in the same turn.
trace.a2.terminationReason = 'moved_toward_stop';
break;
```

**Fix:** Make `context.position` (and related fields like `citiesOnNetwork`) mutable within the loop. After a successful move, update `context.position` to the destination and `continue` instead of `break`. This also requires updating `isBotAtCity` and related helpers to use the mutable position.

---

## Bug D: Delivery loop runs 20x — "delivered Steel to Bruxelles" toast spam

**Severity:** Critical — corrupts game state, spams UI
**Observed:** Haiku turn 5 — 20 `DeliverLoad` plans for Steel at Bruxelles, hitting `MAX_LOOP_ITERS` (20) safety cap.

**Symptom:** `composition.outputPlan` contains 20 `DeliverLoad` entries and 1 `BuildTrack`. 20 delivery trace entries. ~25 toast notifications on the client.

**Root cause:** Same immutable context problem as Bug C. After delivering Steel:
1. Stop index advances (line 258)
2. Post-delivery replan via TripPlanner produces a NEW route (line 268-271)
3. New route starts at `currentStopIndex: 0`
4. `skipCompletedStops` uses `context` to check if stops are complete — but `context.bot.loads` still shows `["Steel"]` (start-of-turn state), so `isStopComplete` doesn't detect the delivery as done
5. `isBotAtCity(context, "Bruxelles")` still true → delivers again
6. Repeats 20 times until safety cap

**Fix:** After a delivery, update `context.bot.loads` to remove the delivered load. This is required for `isStopComplete` and `skipCompletedStops` to work correctly within the same turn. This fix is a subset of the mutable-context work in Bug C.

**Additional fix:** The client should deduplicate delivery toasts — if the same `{loadType, city}` appears multiple times in `loadsDelivered`, only show it once.

**Downstream consequence — route never completes:** Each of the 20 delivery iterations triggers a post-delivery replan (line 268) which produces a NEW route with `currentStopIndex: 0`. The stop index never advances past `stops.length`, so the route is never marked complete. The last replanned route (a stale single-stop delivery) persists in BotMemory. On subsequent turns, the bot re-enters the delivery loop — this bug is **self-perpetuating** across turns until the game is stopped. Nano's turn 8 shows exactly this: `activeRoute` is a single `deliver(Cattle@Ruhr)` stop with `currentStopIndex: 0`. No new strategic route was ever created because the old one was never properly completed.

---

## Bug E: Stale code comments (cleanup)

**Severity:** Low — misleading but not functional
**Files affected:**
- `TurnExecutorPlanner.ts:123` — JSDoc says TripPlanner replan is a "stub" (fully implemented)
- `TurnExecutorPlanner.ts:262` — says RouteEnrichmentAdvisor is "stub in Project 1" (implemented in P2)
- `ActionResolver.ts:101` — says resolvers are "stubs, implemented in BE-010 through BE-013" (implemented)
