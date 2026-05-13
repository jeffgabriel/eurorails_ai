# JIRA-233 — In-turn replan after delivery uses stale cargo state; route gets stuck on impossible stops (behavioral)

## Source

`logs/game-85f3bef2-3ff0-4b65-9749-1eeaafd58278.ndjson` — bot `b8d6197e` (s1), t68-t96. Discovered 2026-05-12 during post-JIRA-230 game review.

Defect class first surfaces at t73 (replan after Potatoes delivery), compounds at t75 (replan after Copper delivery), produces a permanently-stuck route by t79. Bot then PassTurns 17 consecutive times (t80-t96) at $175M cash with 7 cities connected — would have been a viable second victory contender, instead loses to s2 (254M cash + 7 cities).

This is not a JIRA-230 regression. JIRA-230 made the `triple-3carry` candidate competitive enough to surface a latent bug in the route-executor's in-turn replan + route-completion handling.

## Observed behavior — t68-t96 trace

| Turn | Cargo | Active route | Event |
|------|-------|--------------|-------|
| t68 | [] (just delivered Sheep) | new triple-3fresh, 6 stops, idx=0 | Picks `pic:Potatoes@Lodz → pic:Copper@Wroclaw → pic:Coal@Wroclaw → del:Potatoes@London → del:Copper@Madrid → del:Coal@Madrid`. Cap=3 train. |
| t69 | [Potatoes, Copper, Coal] | idx=3 | All 3 pickups done; advances past pickup stops |
| t70-t72 | [Potatoes, Copper, Coal] | idx=3 | Building toward London |
| **t73** | **[Copper, Coal]** ← Potatoes delivered this turn | **new triple-3carry `del:Copper@Nantes → del:Copper@Madrid → del:Coal@Madrid`, idx=0** | Replan picks triple-3carry. Bot now has 2 loads, but route lists 3 deliveries including **2 Copper drops when bot has 1 Copper**. Reasoning: *"All three loads on board; deliver all without new pickups."* |
| t74 | [Copper, Coal] | idx=0 | Moving toward Nantes |
| **t75** | **[Coal]** ← Copper delivered@Nantes this turn | **new single-carry `del:Copper@Madrid`, idx=0** | Replan picks single-carry route. Reasoning: *"Bot already carries Copper; deliver directly to Madrid."* But `carriedLoads = ['Coal']` — no Copper. Planner believed bot still had Copper. |
| t76-t78 | [Coal] | `del:Copper@Madrid idx=0` | Bot moves to Madrid carrying Coal; route says deliver Copper |
| **t79** | **[]** | `del:Copper@Madrid idx=0` ← **unchanged** | Bot arrives at Madrid, delivers **Coal@Madrid** opportunistically (+$37M, satisfies a different demand card in hand). Route still has `del:Copper@Madrid` at idx=0. Coal ≠ Copper → stop doesn't advance. |
| t80-t96 | [] | `del:Copper@Madrid idx=0` ← **17 turns of no change** | PassTurn × 17 at $175M cash, 7 cities. No replan triggers. Bot has 9 demand cards in hand throughout. |

## Three defects, root-cause chain

### Defect A (root cause): post-delivery replan reads stale `bot.loads`

When a delivery action fires within a turn, two things happen close together:

1. The delivery is applied to bot state: `snapshot.bot.loads` is mutated to remove the delivered load, cash is credited.
2. The route-executor detects the delivery and triggers a replan: `planTripDeterministic(snapshot, context, memory)`.

The replan at t73 saw `carriedLoads` as **3 loads** (pre-mutation), not 2 (post-mutation). The replan at t75 saw `carriedLoads` as **including Copper** (pre-Nantes-delivery), not just Coal. The reasoning strings make this explicit:

- t73: "All three loads on board" — but bot has 2
- t75: "Bot already carries Copper" — but bot has Coal only

The replanner's view of `bot.loads` (or whatever drives the `isCarry` flag on demand rows) is **the pre-action state**, while the rest of the world has already moved on. This produces routes the bot physically cannot execute.

### Defect B (downstream): route-advancement requires exact stop match

At t79 the bot delivered Coal@Madrid for $37M. The active route's stop was `deliver Copper@Madrid`. Coal ≠ Copper at the stop-match check, so `currentStopIndex` did not advance and the route stayed open.

For routes the planner intentionally selected, this strict matching is correct (you shouldn't credit a delivery for a stop you weren't trying to do). But combined with Defect A, the bot got handed an impossible route (Copper@Madrid when it had no Copper), executed an opportunistic delivery at the same city, and ended up "still on" a route that can never complete.

### Defect C (downstream): no impossibility detection on the active route

After t79, the bot has empty cargo (`carriedLoads: []`). The active route's next stop requires Copper. The bot has no Copper, and the route has no remaining pickup steps (it was a 1-stop deliver-only route from t75). The route is **provably impossible** from current state forward. Nothing checks this, so the route stays "active" forever and the planner doesn't trigger a fresh top-1 search.

The route-executor's per-turn re-evaluation (`stop 0/1, phase=build`) keeps running and keeps emitting PassTurn because the active-route path is treated as authoritative — replan only triggers on certain transitions (delivery, completion, explicit abandonment), and none of those fire when the route is impossible-but-not-completed.

## Why this only surfaces in some games

Defect A requires a route candidate whose `carryCount` reading depends on the pre-mutation `bot.loads` state. The most common such candidate is `triple-3carry` (3 deliveries, no pickups, requires 3 carries) and `single-carry` (1 deliver, requires 1 carry). Both became more frequently picked after JIRA-230 because:

- The graph-aware cost work made deliver-only routes score better relative to fresh routes
- Supply enumeration produced cleaner route geometry that the aggregate ranker favors

In games where `triple-3carry` and `single-carry` rarely win the top-1 contest, Defect A is silent. Game `85f3bef2` had two `triple-3carry` candidates in the chosen route stream for s1, both at delivery turns — both triggered the stale-state replan.

Defects B and C compound any time Defect A produces an impossible route. Without Defect A, B and C have no input to misbehave on.

## Expected behavior

**Defect A**: the snapshot passed to `planTripDeterministic` for post-delivery replan must reflect post-delivery cargo state. Either (a) apply the delivery's cargo mutation to a local copy of the snapshot before invoking the replanner, or (b) defer the replan trigger until after `TurnExecutor` has fully applied the delivery's effects, or (c) refresh `snapshot.bot.loads` from the underlying source-of-truth (game state DB or in-memory game state) before the replan reads it.

**Defect B**: opportunistic deliveries that satisfy a different demand card than the active route's next stop should NOT silently leave the route "active." Either (a) advance the route's stop only when the action's (loadType, city) matches the next stop AND the stop is still achievable; otherwise (b) trigger a route-impossibility check (see Defect C).

**Defect C**: after every action, the route-executor should verify the active route's remaining stops are still achievable. A delivery stop for load X is achievable iff:
- The bot is currently carrying X, OR
- A remaining pickup stop for X exists earlier in the route OR is reachable as a detour

If the next stop is unachievable and no recovery path exists within the route, the route is impossible — clear `activeRoute` and trigger a fresh replan next turn.

## Pressure-test predictions

**Replay s1's t73 with Defect A fix:**
- Bot's actual cargo at planning time: [Copper, Coal] (2 loads, post-Potatoes-delivery)
- `carryCount` correctly computed as 2 → `triple-3carry` variant skipped (requires carryCount=3)
- Planner picks a pair-2carry variant or single-carry instead
- Route fits actual cargo; no impossible-route situation

**Replay s1's t75 with Defect A fix:**
- Bot's actual cargo at planning time: [Coal] (post-Copper-Nantes-delivery)
- `carryCount` correctly computed as 1, and only Coal is carried → no `Copper@Madrid` single-carry candidate
- Planner picks Coal-delivery or fresh pair from hand

**Replay s1's t79-t80 with Defects A+B+C all fixed:**
- t79: bot delivers Coal@Madrid. Route's next stop is `del:Copper@Madrid` (left over from earlier impossible plan). Defect C check: bot has no Copper, no remaining pickup-Copper steps → route is impossible → clear activeRoute.
- t80: bot replans fresh from empty cargo state. Picks a new pair/single from current hand. No PassTurn streak.

Across the broader trace: the 17-turn idle at $175M cash with 9 cards in hand should be replaced by ~5-6 additional deliveries, plausibly enough to break $250M and contest the victory.

## Scope of this ticket

Tight to the three defects in the chain. All addressed in this ticket because they compound — fixing only Defect A leaves B and C as silent latent bugs that could resurface in other in-turn-mutation scenarios (e.g., pickup actions, drop-load, future opportunistic-delivery extensions).

1. Apply the just-executed delivery to the snapshot's `bot.loads` (or use a freshly-captured snapshot) before invoking the post-delivery replan.
2. When the route-executor advances stops, an action that does NOT match the next stop still triggers an active-route impossibility check.
3. Route-impossibility check: clear `activeRoute` when the next stop's required load is neither in cargo nor reachable via a remaining pickup stop.

## Out of scope

- **Why `selectUpgradeTarget` or `scoreCandidate` produces specific candidate orderings.** Defects A/B/C are in the executor's post-action handling, not in route selection.
- **Refactoring the route-executor's stop-advancement logic.** Defect B's fix adds a check but doesn't restructure the existing matcher.
- **Refactoring the planner's `isCarry` derivation in `DemandEngine` or `detectCarriedLoads`.** Defect A is fixed by feeding fresh state into the planner; the planner itself doesn't need changes.
- **JIRA-232 affordability work.** Unrelated; they ship independently.
- **Opportunistic-delivery handling beyond the impossibility-check trigger.** If opportunistic deliveries warrant a richer route-update model (e.g., re-purpose the route to deliver the alternate card), that's a separate ticket.

## Acceptance

**Defect A unit test in `src/server/__tests__/ai/AIStrategyEngine.test.ts` (or `TurnExecutorPlanner.test.ts` — whichever owns the post-delivery replan trigger):**

Construct a snapshot where bot carries [A, B, C] and the active route is at idx=N just before delivering A. Execute the delivery action. Assert that the replan invocation receives a snapshot view in which `bot.loads = [B, C]`, not `[A, B, C]`.

**Defect A regression for t73:** Reconstruct s1's t73 input state (cargo, hand, position, existing segments). Execute the Potatoes delivery. Run the replan. Assert the chosen candidate's stop count is at most 2× cargo count + remaining hand singles — specifically, NO `triple-3carry` variant is emitted because `carryCount` correctly computes as 2.

**Defect B unit test:** Construct an active route with next stop `del:Copper@Madrid`. Bot's cargo: [Coal]. Bot is at Madrid. Execute an opportunistic Coal delivery at Madrid. Assert:
- The Coal delivery succeeds (existing behavior)
- The route's `currentStopIndex` does NOT advance to 1 (existing behavior — Coal ≠ Copper)
- The post-action impossibility check fires and clears `activeRoute` (new behavior)

**Defect C unit test (impossibility detection):** Construct an active route with next stop `del:Copper@Madrid`. Bot's cargo: [] (no Copper). No pickup-Copper stop remains in the route. Trigger the post-action route check. Assert `activeRoute` is cleared and `routeWasAbandoned` is set in memory.

**End-to-end regression test for t73-t80 of game `85f3bef2`:** Replay s1's turn sequence from t68 to t80 with the three fixes applied. Assert that:
- t73 emits a route whose stops the bot can actually execute (carryCount=2 plan, not 3)
- The 17-turn PassTurn streak does NOT reproduce
- The bot makes at least one additional delivery between t80 and the original t96 stop point

## Evidence

- `logs/game-85f3bef2-3ff0-4b65-9749-1eeaafd58278.ndjson` — s1 events t68-t96. Key turns: t73 (triple-3carry pick), t75 (single-carry pick with stale reasoning), t79 (Coal delivery on Copper route stop), t80-t96 (PassTurn × 17).
- `src/server/services/ai/DeterministicTripPlanner.ts:438-440` — `triple-3carry` variant generation gated by `carryCount === 3`.
- `src/server/services/ai/DeterministicTripPlanner.ts:903-905` (search for `detectCarriedLoads`) — where the planner derives `isCarry` from snapshot/memory state. This is the read point that sees stale `bot.loads`.
- `src/server/services/ai/AIStrategyEngine.ts` — search for `hasDelivery` and the route-state-update block around line 580-640. The post-delivery replan trigger is here.
- `src/server/services/ai/TurnExecutorPlanner.ts` (if it exists) — alternative location for the post-action replan dispatch.
- `src/server/services/ai/PostDeliveryReplanner.ts` — likely owns the post-delivery replan flow; this is where the stale snapshot is most likely passed in.
- `src/server/services/ai/NewRoutePlanner.ts:240-250` — D4 block that consumes `upgradeOnRoute` post-delivery; route advancement may be handled in a sibling block.
- `src/shared/types/GameTypes.ts` — `StrategicRoute.currentStopIndex` field. The advancement logic that increments this is what needs the impossibility check.
- `feedback_passturn_only_legal_case.md` — guardrail: PassTurn must not be the no-plan fallback. The 17-turn streak observed here violates this.
- `project_unplayable_hand_means_unaffordable.md` — guardrail: "no valid route" should mean unaffordable, not impossible-due-to-stale-state.
