# JIRA-241 — Bot lacks a persistent end-game state; replans away from imminent winning moves and chases payouts that overshoot the 250M threshold (behavioral)

In game `181cf810-adc6-4fcd-87f5-78a9c35f7894`, bot s3 was one delivery from winning at t80: 246M cash, 7 major cities connected, carrying Steel for an on-network Venezia delivery (~25M payout). The post-delivery replanner instead picked a higher aggregate-velocity pair `pair:100-Tourists+14-Steel:cB-pA-sup:Ruhr-null` (Tourists pickup at Ruhr in front of the Steel delivery), redirecting the bot away from Venezia. The Steel delivery was subsequently abandoned by later replans (t85, t87), and s3 did not win until t98 at 320M — 18 wasted turns and 70M of overshoot.

The defect is not in any single planner module. It is structural: the bot has no persistent representation of "I am in the end game." Each subsystem re-derives the situation from raw thresholds every turn. The existing victory-related logic (`VICTORY_BUILD_TRIGGER_M = 230` in `routeHelpers.ts`) handles only the asymmetric case `cash ≥ 230 AND cities < 7`. The symmetric case (`cities ≥ 7 AND cash < 250`) has no handling, and even the supported case is non-sticky: a build that briefly dips cash below 230 silently exits "endgame thinking."

## Source

`logs/game-181cf810-adc6-4fcd-87f5-78a9c35f7894.ndjson` — bot s3, t80 (post-Ham-delivery replan) through t98 (eventual win). Discovered 2026-05-15.

## Observed trace (winner s3)

| Turn | cash | route (idx → stops) | event |
|------|-----:|--------------------|-------|
| t79 | 222 | idx=2 → [pickup Ham@Warszawa, pickup Steel@Ruhr, **deliver Ham@Roma**, deliver Steel@Venezia] | About to deliver Ham at Roma; carrying Steel. |
| t80 | 246 | idx=0 → [**pickup Tourists@Ruhr**, deliver Steel@Venezia, deliver Tourists@Nantes] | Ham delivered (+24). **Replan inserts Tourists pickup AHEAD of the winning Steel delivery.** Build target switches to Paris (victory-build branch fires). |
| t81–t84 | 246→220 | (building toward Madrid, Holland, Nantes; Tourists pickup chase) | 26M spent on track in 4 turns; cash dropped below 230 so victory-build branch flips off mid-trip. |
| t85 | 229 | replan → [pickup Machinery@Nantes, deliver Tourists@Nantes, deliver Machinery@Beograd] | Steel/Venezia delivery DROPPED from the route entirely. |
| t87 | 246 | replan → [pickup Oranges@Valencia, deliver Oranges@Sarajevo, deliver Machinery@Beograd] | Bot now chasing a 12-turn, 74M-payout route — far over the cash gap. |
| t88–t97 | 246 | (long traversal Beograd → Valencia → Sarajevo) | Ten consecutive MoveTrain turns. Victory still not declared. |
| t98 | 320 | declared | Win at 320M (70M overshoot) and 7 cities. |

At t80 the bot was, by any reasonable measure, one turn from winning. The replanner's top-aggregate-velocity selection ignored that.

## Cost of the defect

**~18 wasted turns and ~70M of unnecessary cash accumulation.** A trace of comparable games (76–77 turn wins) shows that, absent this defect, s3 should have won at t81 or t82.

## What was expected

Once the bot has cash > 200M, it should adopt an end-game posture and **keep** it for the rest of the game. In that posture:

1. **Route scoring caps payoff at the actual cash gap.** A 30M payout when 1M is needed scores like a 1M payout. The bot stops being seduced by big-ticket deliveries that overshoot.
2. **Routes that don't progress the city goal absorb the cost of one.** When fewer than 7 majors are connected, any candidate route that doesn't connect an unconnected major has the ECU cost of the cheapest unconnected-major connector added to its cost. Pure-cash routes pay the city work they're skipping; routes whose track corridor already connects a needed major pay zero.
3. **Replan only when a candidate is strictly faster** (fewer total turns than the current route's remaining turns) under the adjusted scoring. New demand cards arriving via deliveries are the only trigger for re-evaluation.
4. **No speculative builds outside the active route.** Skip JIRA-240's secondary connector bundling; skip the `findCheapestUnconnectedMajorCity` victory-build branch — those concerns are now subsumed by the scoring rule above.

Net result on the t80 trace: the existing route's remaining turns to Venezia is ~1. The Tourists+Steel pair's total turns is ~9. The candidate is not strictly faster, so the replan is rejected. The bot continues to Venezia and wins on t81–t82.

## What actually happened

Each turn, the planner re-asks "what's the best route by aggregate velocity?" from a stateless view of the world. `PostDeliveryReplanner` calls `TripPlanner` after every delivery without considering whether a replan is *useful*. `DeterministicTripPlanner` picks the candidate with the highest raw aggregate velocity. The result is repeatedly correct in the abstract — "Tourists+Steel is a better income velocity than Steel alone" — and repeatedly catastrophic in context.

## Desired behavior summary

Introduce a persistent `gameState` field on `BotMemoryState`, with values `initial`, `mid`, `end`. Latch the transition `mid → end` when cash first exceeds 200M; never exit. Within `end`:

- **Scoring** (applied in `DeterministicTripPlanner` and any other route ranker):
  - Effective payoff = `min(route.payoff, max(0, VICTORY_INITIAL_THRESHOLD − context.money))`.
  - Effective cost = `route.ecuCost + (cities < 7 AND route.connectsUnconnectedMajor === false ? cheapestUnconnectedMajorConnectorCost(context) : 0)`.
  - Aggregate score formula otherwise unchanged.
- **Replan acceptance** (in `PostDeliveryReplanner`): swap to the candidate only if `candidate.totalTurns < currentRoute.remainingTurns`. Otherwise continue executing the existing route.
- **Build phase** (in `BuildPhasePlanner` / `routeHelpers.resolveBuildTarget`): suppress the `findCheapestUnconnectedMajorCity` victory branch and the JIRA-240 secondary-connector bundling. The scoring rule already drives the bot toward city-progressing routes.
- **Everything else** (discard policy, JIT gate, gap behavior, movement, upgrade) is identical to `mid`.

Initial-state formalization is **deferred** — `initial` is left implicit for this iteration. Only `mid → end` is implemented.

## Subtlety to capture in implementation

A multi-stop route whose **first** delivery alone clears the cash gap should be counted as winning at the first-delivery turn, not the route's last-stop turn. Otherwise a longer route can win the strict-faster comparison when its first stop alone would have ended the game.

## Acceptance

- **AC1 — state latching:** A unit test for `computeGameState(context, memory)` asserting:
  - Returns `mid` when cash ≤ 200 and prior state is `mid`.
  - Returns `end` when cash crosses > 200 for the first time.
  - Returns `end` when prior state is `end` and cash drops back to 180.
  - Never returns `mid` once `end` has been recorded.
- **AC2 — t80 regression:** Reconstruct s3's t80 post-Ham-delivery snapshot from game `181cf810` (cash 246, carries Steel, route `[pickup Ham@Warszawa, pickup Steel@Ruhr, deliver Ham@Roma, deliver Steel@Venezia]` advanced to idx=3, 7 cities connected, Venezia on network). Run `PostDeliveryReplanner.replan`. Assert: route is preserved (no swap), `moveTargetInvalidated: false`, `TripPlanner.planTrip` may be called but its result is rejected because `candidate.totalTurns ≥ currentRoute.remainingTurns`.
- **AC3 — overshoot cap:** Unit test on `DeterministicTripPlanner` scoring in `end` state. Fixture: bot at 249M cash, 7 cities. Two candidates: A) 5M payoff, 2 turns; B) 30M payoff, 8 turns. Assert A wins (effective payoff of B is capped at 1M).
- **AC4 — city cost adjustment:** Unit test on scoring in `end` state. Fixture: 6 cities connected; cheapest unconnected major (Wien) has 14M connector cost from existing network. Two candidates: A) connects Wien naturally (raw NET 20M, 8 turns); B) pure-cash route not touching any unconnected major (raw NET 25M, 8 turns). Assert A wins (B's effective cost adds 14M, making its NET 11M).
- **AC5 — no replan when not strictly faster:** Fixture: current route has 3 remaining turns. Top candidate has 3 total turns (equal). Assert no swap.
- **AC6 — no speculative builds:** In `end` state, `resolveBuildTarget` returns null (or the existing route-based target) and never the cheapest-unconnected-major target. JIRA-240's `secondaryTarget` is never populated.
- **AC7 — game log instrumentation:** Each per-turn record in the game log includes the bot's `gameState` value, so post-game analysis can grep transitions.
- **AC8 — full-game regression:** Replay the `181cf810` t80 snapshot through to game end. Assert s3 wins by t82 (±1 turn).

## Not in scope

- Formalizing `initial → mid` transition. `initial` exists implicitly in setup code paths; capturing it cleanly is deferred to a follow-up.
- Tuning the 200M entry threshold (use 200 verbatim; can revisit after observing post-fix games).
- Multi-major prorated cost models. The cost adjustment uses the single cheapest unconnected major's connector cost. The next decision faces the next-cheapest; we don't sum or average across multiple at once.
- Bonus for routes that connect TWO or more unconnected majors. Zero penalty for connecting one; no extra credit for connecting more.
- Removing or repurposing the existing `VICTORY_BUILD_TRIGGER_M = 230` constant outside the scope of being made unreachable by the new `end`-state gating. The constant's removal/cleanup can be a follow-up after the new rule is observed working.
- LLM-driven endgame decisions. Bot is deterministic medium-skill; no LLM involvement in this fix.
