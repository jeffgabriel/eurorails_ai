# JIRA-238 — Bot fell into a 5-turn DiscardHand loop after the deterministic trip planner produced no feasible candidate; LLM was not consulted as fallback (behavioral)

In game `2f42f3b7-5147-4bc4-aa9b-2a5783e99456`, bot s3 completed a delivery at t16, then issued `DiscardHand` for **five consecutive turns** (t17 through t21). Cash never moved (15M throughout). The `decisionSource` for every discard turn was `heuristic-fallback`, indicating the deterministic trip planner returned no feasible candidate and the engine dropped into the heuristic discard path. The LLM was not called on any of these turns (`llmCallIds: []`). On t22 the deterministic planner finally produced `Luxembourg → Milano` and the bot resumed normal play.

## Source

`logs/game-2f42f3b7-5147-4bc4-aa9b-2a5783e99456.ndjson` — bot s3, t16 (last successful delivery) through t22 (recovery). Discovered 2026-05-13.

## Observed trace

| Turn | action | source | cash | composition.a2 | composition.outputPlan | llmCallIds |
|------|--------|--------|------|----------------|------------------------|-----------|
| t16 | MoveTrain (Chocolate→London) | route-executor | 15 | iters=2, route_complete | [Move, Deliver] | [] |
| t17 | **DiscardHand** | **heuristic-fallback** | 15 | iters=0, none | **[]** | [] |
| t18 | **DiscardHand** | **heuristic-fallback** | 15 | iters=0, none | **[]** | [] |
| t19 | **DiscardHand** | **heuristic-fallback** | 15 | iters=0, none | **[]** | [] |
| t20 | **DiscardHand** | **heuristic-fallback** | 15 | iters=0, none | **[]** | [] |
| t21 | **DiscardHand** | **heuristic-fallback** | 15 | iters=0, none | **[]** | [] |
| t22 | MoveTrain | trip-planner-deterministic | 15 | normal | [Move, Build] | [] |

Across all five discard turns: `composition.a1.opportunitiesFound: 0`, `composition.build.target: null`, `composition.pickups: []`, `composition.deliveries: []`, `hardGates: null`. The trip planner returned no candidate (`a2.iterations: 0, terminationReason: 'none'`), and the engine selected DiscardHand without escalating to the LLM.

## demandRanking on the stuck turns (top candidate per turn)

```
t17  rank 1: Steel    Birmingham → Glasgow    payout 13  score  0.11  estTurns 5  costToSupply 5  costToDeliver 16
t18  rank 1: Labor    Zagreb     → Arhus      payout 28  score -0.93  estTurns 12 costToSupply 4  costToDeliver 21
t19  rank 1: Steel    Ruhr       → Praha      payout 12  score -5.80  estTurns 6  costToSupply 10 costToDeliver 19
t20  (pattern continues with all negative scores)
t21  (pattern continues with all negative scores)
```

Every redrawn hand contained at least one demand the bot could in principle complete; but every demand scored either marginally positive (t17 +0.11) or negative (t18 onward). The deterministic planner's `no_feasible_candidates` outcome and the heuristic-fallback discard suggest a hard threshold: candidates with non-positive aggregate value are rejected outright rather than being treated as the least-bad option.

## Recovery at t22

At t22 the deterministic planner returned a route `pickup Steel at Luxembourg → deliver Steel at Milano` (decisionSource `trip-planner-deterministic`). Cash was still 15M; the bot resumed normal play. Nothing visible in the log explains why this hand was suddenly playable when the previous five weren't — presumably one of the discard-drawn hands finally contained a demand whose computed score cleared the threshold.

## What was expected

A discard fallback should not self-renew. If discarding has not changed the bot's cash or network state, the second consecutive discard is no more useful than the first. After one (or perhaps two) discards without effect, the engine should either:
- Commit to the least-bad available trip, even if its aggregate score is mildly negative (a low-margin trip still beats a no-progress turn);
- Escalate to the LLM fallback, which was never called across all five turns;
- Switch strategy to network expansion (build toward an under-served region) so that future hands have lower track-cost-to-supply / track-cost-to-delivery values;
- At minimum, log that it is in a repeating-discard state and break the loop deterministically.

## What actually happened

Five wasted turns. The `consecutiveDiscards` field at `AIStrategyEngine.ts:593` is incremented per discard turn; whatever uses that counter did not trigger a state change after 1, 2, 3, 4 discards. The `consecutiveLlmFailures` counter at `:595` is also incremented when `model === 'heuristic-fallback'`, which it was on every turn — but no escape valve fired from that signal either.

## Observed knock-on effects

- s3 finished t21 with cash 15M and zero progress while opponents continued earning, widening the score gap.
- The recovery at t22 was lucky (the hand drew a playable demand) rather than caused by any algorithmic correction.

## Acceptance

- After two consecutive `DiscardHand` turns with the same cash and no train movement, the engine must produce a different action on turn 3 — either an LLM-fallback call, a least-bad trip commitment, a network-expansion build, or any other non-discard action.
- A unit test in `AIStrategyEngine.test.ts` builds a snapshot that returns `no_feasible_candidates` from the deterministic planner across multiple consecutive ticks and asserts the engine does not emit `DiscardHand` three turns in a row.

## Not in scope

- Improving the deterministic trip planner's scoring to find positive-value candidates from harder hands — that is a separate scoring tuning ticket, not a fallback-loop fix.
- Tuning the demand ranking weights — same caveat.
- Cash-floor / borrowing behavior — out of scope here.
