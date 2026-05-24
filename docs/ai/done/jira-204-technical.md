# JIRA-204 — Technical fix plan

Companion to `jira-204-behavioral.md`.

## Root cause

The lockup is a missing trigger, not a broken module. Each component on the per-turn path behaves correctly; nothing detects "active route is permanently un-completable from this state, but a different demand in the same hand is achievable."

### What runs each turn (T21 onward)

1. `AIStrategyEngine` sees an active route, delegates to `ActiveRouteContinuer`.
2. `ActiveRouteContinuer` calls `TurnExecutorPlanner.execute`.
3. `MovementPhasePlanner.run` (Phase A): the next stop is `deliver Oil@Zurich`. Zurich is off-network. The composition trace records:
   - `a2.terminationReason: 'stop_city_not_on_network'`
   - `a3.terminationReason: 'origin_is_current_position'` (bot is already at the Dijkstra build origin (30,34))
   - Phase A returns no plans.
4. `BuildPhasePlanner.run` (Phase B): calls `TurnExecutorPlanner.executeBuildPhase` with target `Zurich`. The first check (`src/server/services/ai/TurnExecutorPlanner.ts:276-280`):
   ```ts
   const remainingBudget = Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money);
   if (remainingBudget <= 0) {
     console.log(`${tag} Phase B: no build budget …`);
     return null;
   }
   ```
   `snapshot.bot.money === 0`, so `executeBuildPhase` returns `null`. Phase B has no plans either.
5. `BuildPhasePlanner.ts:208-211` falls through to `plans.push({ type: AIActionType.PassTurn })`.
6. `AIStrategyEngine.ts` Stage 4 guardrail check (`GuardrailEnforcer.ts:107-126`):
   ```ts
   const botIsBroke = snapshot.bot.money < 5;                 // TRUE
   const hasAchievableDemand = context.demands.some(
     d => (d.isSupplyOnNetwork || d.isLoadOnTrain) && d.isDeliveryOnNetwork,
   );                                                         // TRUE — Cheese qualifies
   if (botIsBroke && hasActiveRoute && !hasAchievableDemand && planType !== AIActionType.DiscardHand) { … }
   ```
   `hasAchievableDemand` is correctly `true` (Cheese: Holland → Cardiff is fully on-network). The guard's negation `!hasAchievableDemand` is `false`, so it does **not** force `DiscardHand` — which is the right call, because discarding the hand would throw away the very card that could rescue the bot.
7. `PassTurn` ships. State on T22 is identical to T21. The loop has no exit.

### Why no existing path catches it

- The broke-and-stuck guardrail is shaped around "bot has nothing useful in hand" → `DiscardHand`. It correctly recognises Cheese as useful and stays its hand.
- There is no symmetric guard shaped around "bot has something useful in hand but is locked into a different, unfundable route" → `RouteAbandoned`.
- `MovementPhasePlanner.run` only marks a route abandoned on stop-action failure (`src/server/services/ai/MovementPhasePlanner.ts:141-147`), never on "next stop is off-network and we can't fund the build to reach it."
- `executeBuildPhase` returning `null` is a flat signal. The caller can't tell apart "no budget" from "advisor said skip" from "heuristic produced nothing."

## Fix plan

Add a single trigger that abandons the active route when continuing it is provably impossible from the current cash position **and** an alternative demand is genuinely achievable.

### Where to add the trigger

Two reasonable layers; recommend the guardrail layer for symmetry with the existing broke-and-stuck pattern.

#### Option A — extend `GuardrailEnforcer.checkPlan` (recommended)

In `src/server/services/ai/GuardrailEnforcer.ts`, add a new branch alongside the existing broke-and-stuck check (after line 126), with a different output: instead of forcing `DiscardHand`, signal "abandon the active route."

Trigger conditions (all must hold):

1. `planType === AIActionType.PassTurn` (the engine is about to give up the turn).
2. `botIsBroke` (`snapshot.bot.money < 5`, or stricter: `< minBuildableSegmentCost`).
3. `hasActiveRoute === true`.
4. **The active route's current stop is off-network.** Look at `activeRoute.stops[currentStopIndex].city` and ask `isCityOnNetwork(city, network, gridPoints)` (the helper already used by `DemandEngine.ts:500-501`). If false, the next stop requires building track to reach.
5. `hasAchievableDemand === true` (same predicate as the existing broke-and-stuck — at least one demand has supply-or-load and delivery on-network).

When all five hold, return a `GuardrailPlanResult` whose `plan` is still `PassTurn` for this turn but whose payload signals `routeWasAbandoned`. The mechanism for that signal already exists in the pipeline:

- `MovementPhasePlanner.makeResult` accepts a `routeAbandoned` boolean (`MovementPhasePlanner.ts:472-507`).
- `AIStrategyEngine` already handles `routeWasAbandoned` to clear the active route (the `routeWasCompleted || routeWasAbandoned` branch at `AIStrategyEngine.ts:541-557`).

The cleanest plumb is: have the new guardrail return `overridden: true` with a `reason` string, and add a sibling field `clearActiveRoute: true` that `AIStrategyEngine` checks alongside `guardrailResult.overridden` to set `activeRoute = null` for next turn (mirroring the JIRA-177 pattern at `AIStrategyEngine.ts:485-494`).

Next turn, `activeRoute === null` so the engine takes the no-active-route branch (`AIStrategyEngine.ts:281` onward), `NewRoutePlanner` runs, and Cheese (or whatever the highest-ranked achievable demand is) becomes the new route.

#### Option B — short-circuit inside `MovementPhasePlanner`

Earlier in the loop (`MovementPhasePlanner.ts:362-450`, the "stop city not on network" branch), if `snapshot.bot.money < minBuildSegmentCost` and the A3 build-origin preview can't help, set `trace.a2.terminationReason = 'route_unfundable'` and return `routeAbandoned: true`.

This is a smaller change but bypasses the per-turn guardrail layer where the broke-and-stuck pattern already lives. Recommend Option A so both broke-states stay co-located and inspectable.

### What stays the same

- The broke-and-stuck guardrail's shape and trigger: untouched. It still fires on the no-Cheese-equivalent case (genuinely empty achievable set + active route + broke).
- `BuildPhasePlanner.ts:208-211`: unchanged. PassTurn is still the right last-resort emission when both phases produce nothing — the new trigger fires *upstream* before this matters in practice.
- `executeBuildPhase`'s null-on-no-budget return: unchanged.
- `DemandEngine.isCityOnNetwork` and the demand-network flags: unchanged. They are correct for this game (Cheese genuinely is achievable).

## Acceptance criteria

- A bot at <5M cash with an active route whose current stop is off-network, and at least one demand whose supply (or carried load) and delivery are both on the bot's network, abandons the active route within one turn rather than emitting `PassTurn` indefinitely.
- The next turn, the planner runs the no-active-route path (`NewRoutePlanner`) and selects a route built from the achievable demand.
- The existing broke-and-stuck guardrail still fires when no achievable demand exists (regression-tested by the existing tests of that guard).
- A new test reproduces the JIRA-204 scenario: bot at $0, carrying one load, active route's current stop is `deliver L@OffNetworkCity`, hand contains a demand whose supply and delivery are both on-network → after one turn, `activeRoute` is null and the bot is no longer emitting `PassTurn` on subsequent turns.
- The legitimate `PassTurn` cases (e.g. a mid-route bot that has used its full move budget and has no Phase B work to do this turn) continue to emit `PassTurn` and do **not** abandon the route.

## Out of scope

- Changing `DemandEngine.isCityOnNetwork` or the demand-flag computation. The flags are correct.
- Changing `BuildRouteResolver` or the JIT-build deferral gate.
- Auditing other places where an active route could become un-completable for reasons other than cash exhaustion (e.g. JIRA-203's CITY_ENTRY_LIMIT case). That defect has its own ticket; the trigger condition there is different.
- Honeymoon (2-player) variation rules and the borrowing/restart "mercy rules" — separate features.
- Generalising to "any time the active route looks bad, replan." The trigger here is specifically `broke + off-network next stop + alternative achievable demand`.
